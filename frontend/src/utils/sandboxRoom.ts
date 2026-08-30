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
  /* Design note #1026: `addDoc` is GONE. It was the append's writer, and a transaction cannot use it -- a
     transaction needs its writes named up front, so the ref is minted with `doc(collection)` and set.
     Dropped rather than left imported, for #686's reason about `liveEdgesForHex`: an unused import of the
     non-transactional writer is an invitation to reach for it again, and reaching for it is exactly the bug. */
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

import { resolveVariants, STANDARD_VARIANTS, type GameVariants } from "./gameVariants";

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
    // Design note #910: opens on the printed game; the host changes it in the waiting room.
    variants: STANDARD_VARIANTS,
    createdAt: serverTimestamp(),
  });
  return code;
}

/** The room field that hands out indices -- design note #1026. */
export const SANDBOX_NEXT_INDEX_FIELD = "nextActionIndex";

/** Append one action to a room's log, on an index nobody else can be given.
 *
 *  ==================================================================
 *   DESIGN NOTE 1026: THE INDEX WAS THE CALLER'S GUESS, AND TWO CLIENTS GUESS ALIKE
 *  ==================================================================
 *
 *  REPORTED: "restarting the server caused the active game room to roll back to a much earlier state."
 *
 *  THERE IS NO SERVER HOLDING THAT STATE, which is the first thing worth writing down. This app has no
 *  backend: the log below IS the persistence, every action is already written as its own document at dispatch
 *  time, and `subscribeSandboxLog` already hands back the WHOLE log rather than a delta. A restart loses
 *  nothing that was written. What a restart DOES do is force a replay from scratch -- and a replay is where a
 *  log that has been quietly damaged stops agreeing with the client that was holding the game in memory.
 *
 *  THE DAMAGE IS DUPLICATE INDICES. This function took `nextIndex` FROM THE CALLER and wrote it unchecked.
 *  Its own note argued that was fine -- "the caller is already subscribed to the log, and a re-read per
 *  dispatch buys a guarantee #2 says is unobtainable anyway" -- and that argument is about ORDERING, which is
 *  genuinely unobtainable this way. It is not about UNIQUENESS, which is obtainable and which the rest of the
 *  system assumes:
 *    `effectiveActions` keyed its dead-set on `index` (#1026 in `logRevert.ts`), so one `RevertTo` aimed at a
 *    shared index killed BOTH entries sitting on it -- permanently, on every future replay.
 *    #668 records the other half: two clients on one index each see their own optimistic entry first, and the
 *    doc-id tie-break then REPLACES an applied entry with a different one at the same length, so nothing
 *    shrinks and nothing notices.
 *  Both are invisible while a client holds the state in memory. Both surface the moment it replays.
 *
 *  SO THE INDEX IS ALLOCATED, NOT SUPPLIED. A transaction reads the room's counter, hands out the next value
 *  and writes the entry in one atomic step; a second client racing it is aborted and retried by Firestore
 *  against the counter the first one wrote. That is the one guarantee a transaction actually buys here, and
 *  it is the one the log needed.
 *
 *  THE CALLER'S FIGURE SURVIVES AS A FLOOR. A room created before this field existed has no counter, and
 *  seeding one from zero would hand out indices the log already contains. `Math.max` uses the client's view
 *  of the log length for exactly that case -- and once two clients race on a legacy room, the transaction's
 *  retry makes the second read the counter the first has just written.
 *
 *  RETURNS THE INDEX IT USED, rather than a bare boolean. The caller's guess may not be what it got, and a
 *  caller that advances its cursor by its own guess would desync on the first collision this function
 *  prevented -- which would be a poor way to pay for the fix. `null` is the failure. */
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
): Promise<number | null> {
  const db = getFirestoreDb();
  if (!db) return null;
  const roomRef = doc(db, SANDBOX_ROOMS_COLLECTION, roomCode);
  const actionsRef = collection(roomRef, SANDBOX_ACTIONS_SUBCOLLECTION);
  const payload = JSON.stringify(msg);

  return runTransaction(db, async (tx) => {
    const room = await tx.get(roomRef);
    const counter = Number(room.data()?.[SANDBOX_NEXT_INDEX_FIELD]);
    /* THE FLOOR IS THE CALLER'S VIEW, for a legacy room whose counter does not exist yet. A finite counter
       always wins where it is higher; where it is absent or corrupt, `nextIndex` is the only evidence of how
       long the log already is. */
    const allocated = Number.isFinite(counter) ? Math.max(counter, nextIndex) : nextIndex;

    /* THE COUNTER AND THE ENTRY IN ONE TRANSACTION. Written to the ROOM document, which every appending
       client reads -- that shared read is what makes two simultaneous appends conflict, and a conflict is
       what makes Firestore retry the loser against the winner's counter. */
    tx.set(roomRef, { [SANDBOX_NEXT_INDEX_FIELD]: allocated + 1 }, { merge: true });
    /* `doc(collection)` MINTS THE ID LOCALLY, which is what lets a create happen inside a transaction --
       `addDoc` cannot, because a transaction needs its writes named up front. */
    tx.set(doc(actionsRef), {
      index: allocated,
      actor,
      payload,
      derived,
      createdAt: serverTimestamp(),
    });
    return allocated;
  }).catch(() => null);
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
  /* ==================================================================
      DESIGN NOTE 910: THE HOUSE RULES BELONG TO THE ROOM, NOT TO THE HOST'S BROWSER
     ==================================================================
     REPORTED: "there are no options visible in the Lobby to actually select them."
     AND THE CONTROLS WERE REAL -- in the wrong lobby. #902 put them on `Lobby.tsx`'s create-room form, which
     builds a `RoomDoc` for the on-chain staging path. The screen a table actually starts a sandbox game from
     is `SandboxWaitingRoom`, backed by THIS document, and `handleStartSandboxGame` dispatched
     `SetupGame: { players: seated }` with no variants at all. So the schema was wired end to end along a road
     nobody drives, and the road they do drive carried nothing.
     ON THE ROOM DOCUMENT, which is the part worth stating as a rule: every seat is subscribed to it, so the
     variants are visible to everyone BEFORE they ready up. A table's house rules are terms rather than
     preferences -- #902 -- and terms only one person can see are not terms. Holding them in the host's React
     state would show them to the host alone and hand everybody else a different game at the deal. */
  variants: GameVariants;
}

function toRoomDoc(code: string, data: DocumentData | undefined): SandboxRoomDoc | null {
  if (!data) return null;
  const players = Array.isArray(data.players) ? data.players : [];
  return {
    code,
    hostId: typeof data.hostId === "string" ? data.hostId : "",
    status: data.status === "playing" ? "playing" : "waiting",
    /* Through `resolveVariants` rather than cast: untrusted document data, and a room written by a newer
       client must degrade to the standard game rather than reaching the reducer with a length it cannot
       price. A room created before variants existed reads as 1830, which is what it was. */
    variants: resolveVariants(data.variants as Partial<GameVariants> | undefined),
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
/** Design note #910: the host rewrites the table's house rules while the room is waiting.
 *
 *  WHOLE OBJECT, NOT A FIELD PATCH. The variants are one agreement rather than five independent settings, and
 *  a per-field update would let two rapid clicks interleave into a config neither player chose. The caller
 *  already holds the complete resolved object.
 *  NOT GUARDED HERE. Whether the caller may write this is the SHELL's question -- it knows who the host is and
 *  whether the room is still waiting -- and duplicating that judgement in the writer would put the rule in two
 *  places. Firestore rules are the authority that matters, and `firestore.rules` still has no `sandbox_rooms`
 *  match at all, which is flagged for the Phase 5 audit rather than papered over here. */
export async function setSandboxRoomVariants(
  roomCode: string,
  variants: GameVariants,
): Promise<void> {
  const db = getFirestoreDb();
  if (!db) return;
  await updateDoc(doc(db, SANDBOX_ROOMS_COLLECTION, roomCode), { variants });
}

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

/* ==================================================================
    DESIGN NOTE 857: WHAT THE ROOM IS WAITING FOR, SAID ONCE
   ==================================================================

   ASKED: "in the game lobby, when a non-host player clicks 'Ready,' there should be a notification like
   'Waiting for Host to start the game...' so that players know they don't need to do anything else."

   THE ANSWER ALREADY EXISTED AND ONLY THE HOST COULD SEE IT -- in a `title`. `SandboxWaitingRoom`'s Start
   button carried a three-way explanation of what was blocking, hovered by the one person who did not need it:
   the host is the one who can act. Everyone else, who genuinely cannot, was told nothing.
   THAT IS THE THIRD TOOLTIP THIS SESSION to be holding something a player needs (#806, #839), and the same
   answer: promote it to text and let both surfaces read one rule.

   "WAITING FOR THE HOST" IS NOT ALWAYS TRUE, which is why this returns a reason rather than a sentence. A
   player who readies up in a room of one is not waiting for the host -- the host cannot start either. Saying
   so would be a surface asserting something the authority does not: `canStartSandboxGame` refuses on player
   count first, and this reports the same conditions in the same order so the two cannot disagree.

   THE ROOM'S STATE, NOT THE VIEWER'S. Whose turn it is to act is the caller's business; this says what the
   ROOM is short of, and the caller decides whom to tell. */

/** What is between this room and a dealt game. */
export type WaitingRoomBlock = "need-players" | "need-ready" | "host-to-start" | "not-waiting";

export function waitingRoomBlock(
  room: SandboxRoomDoc | null,
  minPlayers: number,
): WaitingRoomBlock {
  if (!room || room.status !== "waiting") return "not-waiting";
  if (room.players.length < minPlayers) return "need-players";
  if (!room.players.every((player) => player.isReady)) return "need-ready";
  return "host-to-start";
}

/** The sentence for a player who is NOT the host, or `null` when they have nothing to wait for.
 *
 *  `null` UNTIL THEY ARE READY, which is what was asked for -- the line answers "have I finished?", and a
 *  player who has not pressed Ready has not. Telling them what the room lacks before they have done their own
 *  part would read as a refusal of a button they have not tried. */
export function waitingRoomNotice(
  room: SandboxRoomDoc | null,
  minPlayers: number,
  viewer: { isHost: boolean; isReady: boolean },
): string | null {
  if (viewer.isHost || !viewer.isReady) return null;
  switch (waitingRoomBlock(room, minPlayers)) {
    case "need-players":
      return `You are ready. Waiting for more players — Project 18XX needs at least ${minPlayers}.`;
    case "need-ready":
      return "You are ready. Waiting for the other players to mark themselves ready.";
    case "host-to-start":
      return "You are ready. Waiting for the Host to start the game…";
    default:
      return null;
  }
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
