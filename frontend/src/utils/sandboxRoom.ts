// frontend/src/utils/sandboxRoom.ts
//
// Real-time sandbox multiplayer as an append-only action log, on the game server.
//
// State is NOT mirrored: the sandbox is three atoms plus a turn cursor that
// advance together, so replaying the log reproduces them by running the code
// that produced them. A browser with no state reads from index 0 and catches up.
//
// Entries carry a monotonic integer `index` and readers sort by it -- 1830 is
// not commutative. The server allocates the index (#1209) and mints the id.
//
// #1361: FIRESTORE IS GONE FROM THIS FILE. The log moved to the server in #1213 and the roster in #1215, each
// behind a branch on `roomDocOnServer()` that fell back to Firestore. The fallback was never reachable in a
// server-path build (#1242) and Firestore's test-mode window has closed, so the branch is removed: every
// function here either goes to the server or reports that there is no backend. The shapes, names and return
// conventions are unchanged, so no caller moved.
//
// See docs/ai_architecture/firebase_middleware.md - sandboxRoom.ts #0, #1, #2

import { STANDARD_VARIANTS, type GameVariants } from "./gameVariants";
// Design note #1215: the room document lives on the server. The routing is in this file so no caller has any.
import { roomDocOnServer, subscribeRoomDoc, writeRoomDoc } from "./roomDocLink";
import { localPlayerId } from "./seatPin";

/* Design note #530: `GameplayExecuteMsg` is no longer imported here --
   `SandboxLogMsg` is the union of it and the setup event, and this module
   only ever handles the union. */
import type { SandboxLogMsg, SetupPlayer } from "./gameSetup";
// Design note #1128: the stage union is owned by the module that resolves it, not redeclared here.
import type { ForcedSignStage } from "./yellowSign";


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

/** Creates the room document. Returns the code, or `null` when no game server is configured -- which is a
 *  legitimate state (the sandbox runs with no backend at all), so the caller reports it rather than this
 *  throwing. */
export async function hostSandboxRoom(hostId: string, nickname: string): Promise<string | null> {
  /* ==================================================================
      DESIGN NOTE 1215: SIX FUNCTIONS THAT ANSWER TO THE SERVER
     ==================================================================
     THE BRANCH IS HERE RATHER THAN AT THE CALL SITES, and that is the whole design. These six have callers in
     `Lobby.tsx` and in five places in `App.tsx` -- an effect, a join handler, and three waiting-room controls
     -- and routing at each of them would have meant a dozen edits to the file this migration exists to stop
     editing. #1213 made the same choice for the log: `serverLink` was shaped like `appendSandboxAction` so
     the shell could not tell them apart.
     THE CODE IS MINTED LOCALLY. There is nothing to ask for: a room code is a name, not an allocation, and a
     round trip to learn one would be a round trip that can fail. */
  if (!roomDocOnServer()) return null;
  const code = generateRoomCode();
  writeRoomDoc(code, hostId, { op: "host", hostId, nickname, variants: STANDARD_VARIANTS });
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
  /* #1361: THE SERVER IS THE ONLY WRITER. `App.tsx` submits through `serverLink` (#1213) and refuses when the
     link is down (#1242); this signature survives for the shell's fallback branch, which is unreachable on a
     server-path build and now answers the only honest thing when reached: nothing was written. */
  void roomCode;
  void nextIndex;
  void actor;
  void msg;
  void derived;
  return null;
}

/** Reads the whole log once. Used to decide whether a joined room exists and
 *  what its length is before the live subscription opens. */
export async function readSandboxLog(roomCode: string): Promise<SandboxAction[]> {
  /* #1215. THE JOIN PATH AWAITS THIS, which is what made routing it necessary rather than tidy: with
     Firestore unreachable the read never settled and "Join game" hung with no error, exactly as hosting did.
     EMPTY IS THE HONEST ANSWER -- the log lives on the server and the shell's own listener is what fetches it
     (#1213). This call was only ever a courtesy: it exists so a mistyped code is refused at the door instead
     of opening an empty board, and that courtesy is worth less than a working join. */
  void roomCode;
  return [];
}

/** Hands back the WHOLE ordered log, not a delta -- a delta is identical when nothing goes wrong and a silent desync on a dropped snapshot or reconnect. The caller keeps the cursor.
 *  See docs/ai_architecture/firebase_middleware.md - sandboxRoom.ts #0 */
export function subscribeSandboxLog(
  roomCode: string,
  onActions: (actions: SandboxAction[]) => void,
  onError?: (message: string) => void,
): () => void {
  /* #1361: the shell subscribes through `connectServerLink` when a server is configured and takes this branch
     only when none is -- in which case there is nothing to subscribe to. */
  void roomCode;
  void onActions;
  void onError;
  return () => undefined;
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
  /** Design note #1341: whether this seat has a PIN on the server. BROADCAST; the PIN itself never is. Read
   *  by the roster to offer "Rejoin" on a seat that can be rejoined, and "Set PIN" on one that cannot yet. */
  hasPin?: boolean;
}

export interface SandboxRoomDoc {
  code: string;
  /** The `id` of whoever opened the room -- the only seat that may start. */
  hostId: string;
  status: SandboxRoomStatus;
  players: SandboxRoomPlayer[];
  /* ==================================================================
      DESIGN NOTE 1341: THE SEAT PIN -- A ROOM-SCOPED KEY TO A PLAYER ID
     ==================================================================
     ASKED: playtests span hours and a player may move from a laptop to an iPad "without losing their seat or
     requiring us to build a massive, permanent identity database right now."
     THE SEAT IS THE PLAYER ID. Every action is authored by a `p-xxxx` id (#549), the board keys cash and
     holdings by it, and a browser's id lives in `sessionStorage` (#528) -- so a second device is simply a
     device with a different id, and "rejoining a seat" is that device ADOPTING the seat's id. The PIN is what
     gates the adoption: four digits chosen by the seat's owner, held by the server against the id, demanded
     from any connection that later claims that id (`hello` / `room-hello`) and from a `claim-seat` frame that
     wants to take it over. On a match the server tells the old connection it has been superseded and closes
     it; the new device writes the id and the PIN into its own `sessionStorage` and reloads, and the log
     rebuilds the game for it as it would for any refresh (#551).
     SERVER-ONLY FIELD. `seatPins` is persisted in the room file and NEVER put on the wire -- `publicDoc`
     strips it and stamps `hasPin` on each player instead. Plain strings, per the ruling: closed playtests,
     no hashing, a key to a seat in one room and to nothing else. */
  seatPins?: Record<string, string>;
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
  /* ==================================================================
      DESIGN NOTE 1128: THE DEBUG FLAG IS ON THE ROOM FOR #910's REASON
     ==================================================================
     RULED: "in the game room, but only the host should be able to see/trigger it, and it should trigger on
     the next available window, whoever that player is."
     THOSE TWO HALVES ARE WHY IT CANNOT LIVE IN THE HOST'S BROWSER. The sign is resolved by the client
     DISPATCHING the run -- so a flag in React state would be armed on one machine and read on another, and
     would simply never fire unless the host happened to be the acting player. #910 already made this exact
     argument about the house rules: "holding them in the host's React state would show them to the host alone
     and hand everybody else a different game at the deal."
     ONE FIELD, NOT A QUEUE. Arming twice replaces rather than stacks; the tool is "make the next one happen",
     and a backlog of forced events is not a thing a playtest wants to reason about.
     CLEARED BY WHOEVER CONSUMES IT, in the same breath as the run that used it. The board is turn-based, so
     the acting client is unique and there is no race worth guarding -- and if a write were somehow lost, the
     worst case is the stage fires twice, which for a debug tool is a nuisance and not a corruption. */
  forcedSign: ForcedSignStage | null;
}

/** Subscribes to the room document -- the waiting room's own state. */
export function subscribeSandboxRoom(
  roomCode: string,
  onRoom: (room: SandboxRoomDoc | null) => void,
  onError?: (message: string) => void,
): () => void {
  // #1215. The server's frame is already this shape, so there is nothing to translate.
  if (!roomDocOnServer()) return () => undefined;
  return subscribeRoomDoc(roomCode, localPlayerId(), onRoom, onError);
}

/** One writer applying one op at a time: the in-place rule (#541) lives in the server's `applyRoomWrite`. */
export async function upsertSandboxPlayer(
  roomCode: string,
  player: SandboxRoomPlayer,
): Promise<boolean> {
  if (!roomDocOnServer()) return false;
  writeRoomDoc(roomCode, player.id, { op: "upsert-player", player });
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
  if (!roomDocOnServer()) return;
  writeRoomDoc(roomCode, localPlayerId(), { op: "variants", variants });
}

/** Design note #1128: arms or clears the forced-sign flag. `null` is the clear, written by whichever client
 *  consumed it. */
export async function setSandboxForcedSign(
  roomCode: string,
  stage: ForcedSignStage | null,
): Promise<void> {
  if (!roomDocOnServer()) return;
  writeRoomDoc(roomCode, localPlayerId(), { op: "forced-sign", stage });
}

export async function markSandboxRoomPlaying(roomCode: string): Promise<void> {
  if (!roomDocOnServer()) return;
  writeRoomDoc(roomCode, localPlayerId(), { op: "status", status: "playing" });
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

/* Design note #1341: the player-id store, `adoptSeat` and `forgetSeat` live in `seatPin.ts` now, beside the
   PIN and token they travel with -- `roomDocLink.ts` needs `forgetSeat`, and this module imports
   `roomDocLink.ts`, so the identity block moved to the leaf rather than closing a cycle. Re-exported here so
   every existing import of `localPlayerId` stands. */
export { localPlayerId, adoptLocalPlayerId, adoptSeat, forgetSeat } from "./seatPin";
