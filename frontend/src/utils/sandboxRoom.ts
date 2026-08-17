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
  serverTimestamp,
  setDoc,
  type DocumentData,
  type FirestoreError,
  type QueryDocumentSnapshot,
} from "firebase/firestore";

import { getFirestoreDb } from "../config/firebase";
import type { GameplayExecuteMsg } from "./sessionKey";

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
export function decodeAction(action: SandboxAction): GameplayExecuteMsg | null {
  try {
    return JSON.parse(action.payload) as GameplayExecuteMsg;
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
export async function hostSandboxRoom(hostLabel: string): Promise<string | null> {
  const db = getFirestoreDb();
  if (!db) return null;
  const code = generateRoomCode();
  await setDoc(doc(db, SANDBOX_ROOMS_COLLECTION, code), {
    code,
    host: hostLabel,
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
  msg: GameplayExecuteMsg,
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
