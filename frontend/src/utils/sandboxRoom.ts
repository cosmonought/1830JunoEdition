// frontend/src/utils/sandboxRoom.ts
//
// Real-time Sandbox multiplayer, as an append-only action log on Firestore.
//
// ===================================================================
//  DESIGN NOTE 0: WHY EVENT SOURCING IS THE ONLY HONEST OPTION HERE
// ===================================================================
//
// The obvious design is to mirror the sandbox GAME STATE into a document and
// let `onSnapshot` push it around. That cannot work in this codebase, and the
// reason is worth stating because it is the reason for everything below.
//
// The sandbox is not one state object. It is THREE atoms plus a turn cursor:
//
//   `sandboxState`   the `GameStateResponse`, via `applySandboxAction`
//   `mapGrid`        the tile grid, via `applySandboxLayTile`
//   `sandboxMarket`  the price chart, via `applySandboxMarketAction`
//   App-local        `orSubPhase`, route drafts, pending offers, and more
//
// They advance TOGETHER on one dispatch, and each reducer takes a context
// built from the others -- `applySandboxAction` is handed `mapGrid` and a
// `marketPriceFor` that reads the chart. Mirroring one atom would desync the
// other two; mirroring all of them means serialising a graph whose shape is
// an implementation detail of four modules, and any field added anywhere
// would silently stop replicating.
//
// THE ACTION LOG IS ALREADY COMPLETE, which is what makes the alternative
// work. Every sandbox mutation goes through `runGameplayAction` as a
// `GameplayExecuteMsg` -- including the tile lay, which dispatches `LayTile`
// alongside its local `setMapGrid` (App.tsx `handleSandboxLayTile`), so the
// board is reconstructible from the same stream. Replaying the log through
// the existing pipeline therefore reproduces all three atoms by running the
// code that produced them, rather than by copying their output.
//
// That is also what gives refresh-resilience for free: a browser with no
// state reads the log from index 0 and arrives where everyone else is.
//
// ===================================================================
//  DESIGN NOTE 1: THE INDEX IS THE CONTRACT
// ===================================================================
//
// Order is everything -- 1830 is not commutative, and "buy share then pay
// dividend" is a different game from the reverse. So each entry carries a
// monotonic integer `index` and readers sort by it.
//
// AN INTEGER, NOT `serverTimestamp()`, and `ChatBox`'s design note #2 has
// already recorded why in this codebase: `serverTimestamp()` resolves to
// `null` in the local snapshot the SDK emits optimistically, so an entry is
// briefly unsortable by the very field meant to sort it. Chat can tolerate a
// message that jumps a place on write. A game state machine cannot: applying
// two actions in the wrong order produces a divergent board that never
// reconciles, because every later action is computed against it.
//
// `createdAt` rides along anyway, for debugging and for a human-readable
// ordering in the Firebase console. Nothing reads it for sequencing.
//
// ===================================================================
//  DESIGN NOTE 2: THE COLLISION THIS DOES NOT SOLVE
// ===================================================================
//
// Two clients writing index N simultaneously is possible. Firestore's
// `addDoc` gives each a distinct document, so both survive with the same
// index -- and the tie-break below (document id) is deterministic, so every
// client resolves it IDENTICALLY. Nobody diverges.
//
// What it does not do is prevent the second action from being computed
// against a state that did not include the first. That is a genuine
// limitation of a client-authoritative log with no referee, and it is stated
// here rather than hidden: the sandbox has no server to arbitrate, and
// building one is a backend change this pass is scoped out of. In practice
// 1830 is strictly turn-based and two players acting in the same instant are
// already playing wrongly -- the hotseat seat cursor makes it visible when
// they do.

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

/** Design note #519: a NEW top-level collection, beside `games` rather than
 *  inside it. A sandbox room has no chain game, no contract address and no
 *  on-chain roster -- it shares none of `RoomDoc`'s shape, and `firestore.rules`
 *  guards that collection with rules (write-once `chainGameId`, no
 *  game-state fields) written for a document this one is not. */
export const SANDBOX_ROOMS_COLLECTION = "sandbox_rooms";
export const SANDBOX_ACTIONS_SUBCOLLECTION = "actions";

/* ==================================================================
 *  DESIGN NOTE 520: THE ROOM CODE IS READ ALOUD
 * ==================================================================
 *
 * The code's whole job is to survive being spoken over a voice call and
 * typed by somebody else, so the alphabet is chosen for that rather than for
 * entropy per character.
 *
 * `0/O`, `1/I/L` and `5/S` are OUT. They are the pairs that get misheard and
 * mistyped, and a room code that fails one time in twenty is worse than a
 * slightly longer one that never does. What remains is 22 letters and 7
 * digits; three of them is ~24,000 combinations, which is ample for a game
 * where rooms are created and abandoned within an hour and a collision
 * merely means picking again.
 *
 * THE FIRST DRAFT OF THIS TABLE KEPT `0`. It dropped `O` from the letters and
 * `1`/`5` from the digits and then ended "...67890" -- so the one character
 * most likely to be confused with a letter survived the rule written to
 * remove it. The harness caught it on the second run; a reviewer reading the
 * string would have had to count. That is the argument for asserting the
 * PROPERTY (no confusable character appears) rather than pinning the
 * alphabet, which would merely have recorded the mistake.
 *
 * THE `JUNO-` PREFIX IS PART OF THE CODE, not decoration. It makes the
 * string self-describing when it turns up pasted in a chat window with no
 * context, and it gives `parseRoomCode` something to recognise so a player
 * who pastes the whole thing and a player who types only the suffix both
 * succeed.
 */
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

/** Normalises whatever a player typed into the canonical code, or `null`.
 *
 *  FORGIVING ON INPUT, STRICT ON OUTPUT. Lower case, missing prefix,
 *  surrounding spaces and a pasted `juno-4t2` all resolve to `JUNO-4T2`;
 *  anything that is not a real code resolves to `null` rather than to a
 *  plausible-looking room nobody is in. A player mistyping a code should be
 *  told, not silently dropped into an empty room they will wait in. */
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
  /** The `GameplayExecuteMsg` itself. Stored as JSON TEXT rather than as a
   *  nested map, deliberately -- Firestore rejects nested arrays, and
   *  several messages carry one (`RunManualRoute.path` is an array of
   *  objects). Round-tripping through JSON also guarantees every client
   *  applies a structurally identical object rather than one Firestore has
   *  reshaped on the way through. */
  payload: string;
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

function toAction(snapshot: QueryDocumentSnapshot<DocumentData>): SandboxAction | null {
  const data = snapshot.data();
  const index = Number(data.index);
  if (!Number.isFinite(index)) return null;
  if (typeof data.payload !== "string") return null;
  return {
    index,
    id: snapshot.id,
    actor: typeof data.actor === "string" ? data.actor : "",
    payload: data.payload,
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

/** Appends one action to the room's log.
 *
 *  `nextIndex` is supplied by the CALLER rather than read here, and that is
 *  the whole reason this is not a transaction: the caller already holds the
 *  live log (it is subscribed to it), so it knows the next index without a
 *  round trip. A `runTransaction` that re-read the collection on every
 *  dispatch would add a network round trip to every click for a guarantee
 *  design note #2 explains this cannot make anyway. */
export async function appendSandboxAction(
  roomCode: string,
  nextIndex: number,
  actor: string,
  /* Design note #530: the log carries the setup event as well as gameplay
     messages. Both are single-key objects and both round-trip as JSON, so
     widening this changes nothing about how an entry is written. */
  msg: SandboxLogMsg,
): Promise<boolean> {
  const db = getFirestoreDb();
  if (!db) return false;
  await addDoc(
    collection(db, SANDBOX_ROOMS_COLLECTION, roomCode, SANDBOX_ACTIONS_SUBCOLLECTION),
    {
      index: nextIndex,
      actor,
      payload: JSON.stringify(msg),
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

/** Subscribes to the room's log.
 *
 *  HANDS BACK THE WHOLE ORDERED LOG on every change, not a delta. The
 *  consumer's job is "make my state match this sequence", and a delta would
 *  make it "apply exactly the entries I have not seen" -- which is the same
 *  thing when nothing goes wrong and a silent desync when anything does (a
 *  dropped snapshot, a reconnect, a late entry landing behind the cursor).
 *  The caller tracks how far it has applied and takes the tail; that cursor
 *  is cheap to keep and impossible to get subtly wrong.
 *
 *  Returns the unsubscribe function, or a no-op when Firestore is absent. */
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

/* ==================================================================
 *  DESIGN NOTE 527: THE ROOM DOCUMENT IS THE ANTEROOM, NOT THE GAME
 * ==================================================================
 *
 * Design note #0 argues at length that game STATE must not be mirrored into
 * Firestore -- it must be derived from the action log. The waiting room is
 * the one thing that is legitimately document state, and the distinction is
 * worth being precise about because it looks like an exception.
 *
 * WHAT LIVES IN THE DOCUMENT is everything true BEFORE the game exists:
 * who is here, what they are called, whether they have said they are ready.
 * None of it is derived from anything, none of it is ordered, and a late
 * write simply wins -- which is exactly the shape `onSnapshot` on a document
 * handles well and an append-only log handles badly (a "ready" that toggles
 * twice would otherwise be two entries the replay has to reconcile).
 *
 * THE MOMENT THE GAME STARTS, that stops being true and the document stops
 * being authoritative. `status: "playing"` is a latch, and everything after
 * it comes from the log. So the two systems never overlap: the document
 * owns the lobby, the log owns the game, and `status` is the handover.
 */
export type SandboxRoomStatus = "waiting" | "playing";

export interface SandboxRoomPlayer {
  id: string;
  nickname: string;
  isReady: boolean;
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

/** Adds this player to the room, or updates their nickname/ready flag.
 *
 *  A TRANSACTION, unlike `appendSandboxAction`. The players array is a
 *  read-modify-write on ONE field that several clients touch at once, so a
 *  plain update would drop whoever wrote a millisecond earlier -- the
 *  classic lost join. The action log needs no transaction because appends
 *  never touch the same document; this does because they all touch this one. */
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
    /* ==================================================================
     *  DESIGN NOTE 541: EDITING A NAME IS NOT REJOINING
     * ==================================================================
     *
     * REPORTED: clicking "Set Name" twice appears to reorder the players.
     *
     * It did exactly that. This filtered the player out and appended them:
     * `[...others, player]`. So every nickname edit and every ready toggle
     * moved that player to the BACK of the array, and two people editing
     * in turn churned the whole roster.
     *
     * The order is not cosmetic. `toSetupPlayers` reads this array to build
     * the payload the host shuffles, so a lobby whose list reshuffles itself
     * while people are typing is a lobby whose seating nobody can predict --
     * and it moves under the reader while they are looking at it.
     *
     * SO AN EXISTING PLAYER IS UPDATED IN PLACE and only a genuinely new one
     * is appended. Arrival order is then stable for the whole lobby, which
     * is the one thing a waiting-room roster should be. */
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

/** Every player marked ready, and enough of them to deal a legal game.
 *
 *  BOTH CONDITIONS, and the second is the one a "ready check" usually
 *  forgets: one person alone in a room can tick ready and satisfy "all
 *  ready" trivially. 1830 needs at least two. */
export function canStartSandboxGame(room: SandboxRoomDoc | null, minPlayers: number): boolean {
  if (!room || room.status !== "waiting") return false;
  if (room.players.length < minPlayers) return false;
  return room.players.every((player) => player.isReady);
}

/** The waiting room's roster, as the setup payload wants it. */
export function toSetupPlayers(room: SandboxRoomDoc): SetupPlayer[] {
  return room.players.map((player) => ({ id: player.id, nickname: player.nickname }));
}

/* ==================================================================
 *  DESIGN NOTE 528: WHO THIS BROWSER IS
 * ==================================================================
 *
 * The waiting room needs to tell one player from another, and the sandbox
 * has no wallet and no authentication. So each browser mints an id once and
 * keeps it in `sessionStorage`.
 *
 * SESSION, NOT LOCAL, storage. Two tabs of the same browser must be two
 * players -- that is how a single developer playtests this at all -- and
 * `localStorage` is shared across tabs, so both would claim the same seat
 * and the second join would overwrite the first. `sessionStorage` is
 * per-tab, which is exactly the granularity wanted.
 *
 * IT SURVIVES A REFRESH, which is the other half: a player who reloads
 * mid-game must reclaim their own seat rather than appear as a new one and
 * find the game has more players than it dealt for.
 */
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
