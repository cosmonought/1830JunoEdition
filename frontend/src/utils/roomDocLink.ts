// frontend/src/utils/roomDocLink.ts
//
// The waiting room's document, carried by the game server instead of by Firestore.
//
// ==================================================================
//  DESIGN NOTE 1215: THE LOBBY WAS STILL HOSTAGE TO FIRESTORE
// ==================================================================
//
// FOUND THE HARD WAY. Firestore went unreachable mid-playtest -- `firestore.googleapis.com` timing out on
// both A and AAAA while the rest of the internet answered -- and "Host game" did nothing at all. Not an
// error: `hostSandboxRoom` awaits a write that never lands, `sandboxRoomBusy` stays true, and the button
// sits there looking broken. The whole point of Phase 2 was to stop a game depending on a service being up,
// and the game log had indeed stopped. THE ROOM DOCUMENT HAD NOT, so the table could not be seated at all.
//
// THE ROSTER IS LOAD-BEARING, which #856 already established: `SandboxWaitingRoom` counts it, the Start
// button is gated on it, and `toSetupPlayers` reads it to build the deal. A room nobody can be written into
// is a room nobody can start.
//
// ---------------------------------------------------------------------------
//  WHY THIS IS NOT IN THE ACTION LOG
// ---------------------------------------------------------------------------
//
// THE OBVIOUS MOVE IS TO MAKE JOINING AN ACTION, and it is wrong. #522 says the log is the game and #549
// says the reducer is a pure function of it; a `PlayerJoinedTheLobby` entry is neither -- it changes no
// board, it has no rule, and every replay, golden master and digest would have to learn to step over it.
// The lobby is what happens BEFORE there is a game to have a log of.
//
// SO IT IS A SEPARATE RECORD ON THE SAME SERVER, and the separation is the design:
//
//   THE LOG          appended, ordered, replayed, hashed, and settled on chain.
//   THE ROOM DOC     last-write-wins, unordered, never replayed, and thrown away when the game ends.
//
// A rule must never be decided from the second one. `turnAuthority` reads the board; the roster is how
// players find each other, not what says who may act.
//
// ---------------------------------------------------------------------------
//  ONE SOCKET PER ROOM, AND WHY A SECOND SOCKET IS ACCEPTABLE
// ---------------------------------------------------------------------------
//
// A tab in a room ends up with two connections: `serverLink` for the log and this one for the roster. The
// alternative was to thread the game link's handle down into `sandboxRoom.ts`, which every one of the six
// room functions is called without -- from effects, from the lobby, from three waiting-room controls. THAT
// PLUMBING WOULD HAVE TOUCHED APP.TSX IN A DOZEN PLACES, which is the file this migration exists to stop
// editing. A module-level registry keyed by room code costs one socket and no call sites.

import { CLIENT_BUILD_ID, GAME_SERVER_URL } from "../config";
import type { GameVariants } from "./gameVariants";
import type { ForcedSignStage } from "./yellowSign";
import type { PresenceState } from "./presence";
import { SEAT_SUPERSEDED_CODE, forgetSeat, readSeatPin, readSeatToken } from "./seatPin";
import type { SandboxRoomDoc, SandboxRoomPlayer, SandboxRoomStatus } from "./sandboxRoom";

/* ==================================================================
    DESIGN NOTE 1361: EVERYTHING THAT WAS ON FIRESTORE RIDES THIS SOCKET NOW
   ==================================================================
   Firestore's test-mode window closed and every remaining listener -- chat, route presence, the parked
   staging lobby -- became a CORS error in the console. The game itself had already left (#1213 the log, #1215
   the roster); what stayed behind were the three records that were "off-chain only" and had therefore never
   been worth moving. They are worth moving now, and they all move HERE rather than each growing a socket:

     chat        `chat-send` up, `chat` (the whole transcript, capped) down.        #1361a
     presence    `presence-set` up, `presence` (every seat's current hint) down.    #1361a
     the lobby   `lobby-hello` / `lobby-watch` / `lobby-write` up; `lobby`, `lobby-room`, `lobby-ack` down.  #1361b

   ONE FRAME BUS, NOT THREE PARSERS. The connection keeps a listener set PER FRAME KIND and the last frame of
   each kind it heard, so a subscriber that mounts late is answered at once -- the same courtesy the room
   document already extended (#1215) -- and a new record costs a kind name, not a socket. The room document's
   own handling is unchanged and sits beside the bus, because its subscribers key on the document rather than
   the frame.

   AND THE SOCKET RECONNECTS, which it did not before. Firestore's SDK re-established its listeners on its own
   and nobody noticed the room-doc socket did not: a dropped tunnel meant a roster, a transcript and a set of
   routes that stopped moving until somebody reloaded. A connection with anybody still listening reopens on a
   short backoff, says `room-hello` again and is answered with the current documents. A connection nobody is
   listening to is let go. */

/** The writes the waiting room performs, one per existing Firestore writer. Named operations rather than a
 *  document patch: the server applies each one under the rule that belongs to it (an upsert is in-place,
 *  #541), and a client that could patch arbitrary fields could rewrite the host. */
export type RoomDocWrite =
  | { op: "host"; hostId: string; nickname: string; variants: GameVariants }
  | { op: "upsert-player"; player: SandboxRoomPlayer }
  | { op: "variants"; variants: GameVariants }
  | { op: "forced-sign"; stage: ForcedSignStage | null }
  | { op: "status"; status: SandboxRoomStatus };

export interface RoomDocFrame {
  kind: "room";
  room: string;
  doc: SandboxRoomDoc | null;
}

/* ==================================================================
    DESIGN NOTE 1341: TWO SEAT FRAMES, ANSWERED ON THIS SOCKET
   ==================================================================
   The seat PIN travels on the room-doc socket, not the log's: it is a fact about the roster, never a move
   (#1215's line). Two requests -- set MY seat's PIN, and CLAIM another seat with its PIN -- and one answer
   shape, correlated by `requestId` because both may be in flight from one tab. The PIN is never in a
   broadcast document; only the answer to the asker carries the outcome. */
export interface SeatPinRequest {
  kind: "seat-pin";
  room: string;
  requestId: string;
  playerId: string;
  pin: string;
  /** Required when the seat already has one -- a PIN is changed only by whoever knows it. */
  currentPin?: string;
}

export interface ClaimSeatRequest {
  kind: "claim-seat";
  room: string;
  requestId: string;
  playerId: string;
  pin: string;
}

/** Design note #1355: one seat that carries the PIN a player typed, anywhere on this server. */
export interface FoundSeat {
  room: string;
  playerId: string;
  nickname: string;
  status: string;
}

export interface SeatsAnswerFrame {
  kind: "seats";
  requestId: string;
  seats: FoundSeat[];
  reason?: string;
}

export interface SeatAnswerFrame {
  kind: "seat";
  requestId: string;
  ok: boolean;
  /** The server's sentence when `ok` is false. */
  reason?: string;
  /** On `ok`: the session token this device now holds for the seat (`seatPin.ts`). */
  token?: string;
}

/* ---- #1361a: chat ---- */

/** One line of a room's transcript, as the server keeps it. `author` is the connection's identity (a player
 *  id in a sandbox, a wallet address in the staging lobby); `displayName` is denormalised at send time so a
 *  later rename does not rewrite bylines on things already said. */
export interface RoomChatEntry {
  id: string;
  author: string;
  displayName: string;
  text: string;
  /** The server's clock, milliseconds. One clock, so the transcript orders the same for everybody. */
  at: number;
}

export interface ChatSendRequest {
  kind: "chat-send";
  room: string;
  text: string;
  displayName: string;
}

/** The whole transcript, every time -- the same shape of guarantee the log's subscription gives (#0): a delta
 *  is identical when nothing goes wrong and a silent hole on a dropped frame. Capped on the server. */
export interface ChatFrame {
  kind: "chat";
  room: string;
  messages: RoomChatEntry[];
}

/* ---- #1361a: presence ---- */

export interface PresenceSetRequest {
  kind: "presence-set";
  room: string;
  /** `null` clears this connection's seat. */
  state: PresenceState | null;
}

export interface PresenceFrame {
  kind: "presence";
  room: string;
  entries: PresenceState[];
  /** #1397: the server's clock when it sent this, so `at` (also the server's) can be read as an age. Absent
   *  from a server built before #1397, in which case `at` is taken as it comes. */
  now?: number;
}

/** True when the game server is configured, which is what decides whether any of this is used.
 *
 *  THE SAME SWITCH AS #1213, deliberately. Two independent flags would let a build take its log from one
 *  place and its roster from another, and the failure that produces -- a room whose players are elsewhere --
 *  is exactly the kind of split-brain this migration is trying to end. */
export function roomDocOnServer(): boolean {
  return Boolean(GAME_SERVER_URL);
}

interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

type Listener = (doc: SandboxRoomDoc | null) => void;

/** #1361: a listener for one frame kind on the bus. */
type FrameListener = (frame: unknown) => void;

interface Connection {
  socket: SocketLike;
  claim: string;
  /** The last document the server sent. Handed to a late subscriber immediately, so a component that mounts
   *  after the first frame is not left waiting for a change that may never come. */
  latest: SandboxRoomDoc | null;
  /** Whether anything has arrived yet. #764's distinction: "no such room" and "have not heard" differ, and
   *  the waiting room gates its own not-knowing on the first snapshot. */
  heard: boolean;
  listeners: Set<Listener>;
  errors: Set<(message: string) => void>;
  /** #1361: listeners by frame kind, and the last frame of each kind, for the late subscriber. */
  frames: Map<string, Set<FrameListener>>;
  lastFrame: Map<string, unknown>;
  /** #1361: frames to say again after a reconnect -- a subscription the server keeps per socket
   *  (`lobby-hello`, `lobby-watch`) is gone with the socket and has to be re-stated. Keyed so a later
   *  request for the same thing replaces rather than stacks. */
  standing: Map<string, string>;
  backlog: string[];
  open: boolean;
  /** #1341: seat requests awaiting their answer, by `requestId`. */
  pending: Map<string, (answer: SeatAnswerFrame) => void>;
  /** #1355: PIN lookups awaiting their answer. */
  pendingSeats: Map<string, (answer: SeatsAnswerFrame) => void>;
  /** #1361: the reconnect, when one is scheduled; `null` once the connection is let go. */
  reconnect: number | null;
  attempts: number;
  /** Set by `resetRoomDocLinks` and by the socket being let go: a close after this schedules nothing. */
  retired: boolean;
  /** #1363: a `host` write has been sent on this connection and no document has come back yet. */
  hosting: boolean;
}

const connections = new Map<string, Connection>();

/** Injectable for tests; the browser has no reason to touch it. */
let socketFactory: (url: string) => SocketLike = (url) =>
  new WebSocket(url) as unknown as SocketLike;

export function setRoomDocSocketFactory(factory: (url: string) => SocketLike): void {
  socketFactory = factory;
}

/** Drops every connection. Tests only -- a room's socket otherwise lives as long as the tab. */
export function resetRoomDocLinks(): void {
  connections.forEach((connection) => {
    connection.retired = true;
    if (connection.reconnect !== null) window.clearTimeout(connection.reconnect);
    connection.socket.close();
  });
  connections.clear();
}

/** #1361: the backoff between reconnects -- short, because the wire is usually a tunnel hiccup, and capped. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;

/** Whether anybody would notice this connection coming back. */
function anybodyListening(connection: Connection): boolean {
  if (connection.listeners.size > 0) return true;
  let listening = false;
  connection.frames.forEach((set) => {
    if (set.size > 0) listening = true;
  });
  return listening;
}

/** Opens (or reopens) the socket for a connection and wires its handlers. */
function attach(room: string, connection: Connection): void {
  const socket = socketFactory(GAME_SERVER_URL ?? "");
  connection.socket = socket;

  socket.onopen = () => {
    connection.open = true;
    connection.attempts = 0;
    /* #1341: the PIN this tab holds for the room, if any -- the server demands it for a seat that has one. */
    socket.send(
      JSON.stringify({
        kind: "room-hello",
        room,
        build: CLIENT_BUILD_ID,
        claim: connection.claim,
        pin: readSeatPin(room) ?? undefined,
        token: readSeatToken(room) ?? undefined,
      }),
    );
    // #1361: the subscriptions the server keeps per socket, said again.
    connection.standing.forEach((text) => socket.send(text));
    for (const queued of connection.backlog.splice(0)) socket.send(queued);
  };

  socket.onmessage = (event) => {
    let frame: RoomDocFrame | { kind: string; reason?: string };
    try {
      frame = JSON.parse(String(event.data)) as typeof frame;
    } catch {
      connection.errors.forEach((onError) => onError("unparseable room frame from server"));
      return;
    }
    if (frame.kind === "room") {
      const doc = (frame as RoomDocFrame).doc;
      /* ==================================================================
          DESIGN NOTE 1363: THE HOST'S FIRST ANSWER IS "NO SUCH ROOM", AND IT IS NOT THE ANSWER
         ==================================================================
         REPORTED: a screen flash between the lobby and the waiting room on Host. Recorded frame by frame: the
         hold (#1258) for ~270ms, then the BOARD -- Waterfall Auction, "OFFLINE SANDBOX" -- for one frame, then
         the waiting room. #764 built the hold for exactly this flash on the Firestore path and it worked
         there, because `setDoc` was awaited before the subscription opened: the first snapshot was the room.
         ON THE SERVER PATH THE FIRST FRAME IS `null`. `hostSandboxRoom` writes the room through this socket,
         and #1216 sends `room-hello` and the `host` write back to back; the server answers the hello at once
         -- with `doc: null`, since the write behind it has not been applied -- and only then applies the write
         and broadcasts the room. #764's rule, "the first snapshot ends the not-knowing, whatever it contains",
         is the right rule for a JOIN (a null there really is "no such room") and the wrong one for the tab
         that has a create in flight: for that tab, null is not an answer yet.
         SO A NULL HEARD WHILE THIS CONNECTION'S OWN `host` WRITE IS UNANSWERED IS NOT DELIVERED. The
         connection remembers that it sent a create; the first non-null document clears it. A join sends no
         `host` write and is unaffected; the shell's gate is untouched. */
      if (doc === null && connection.hosting) return;
      connection.hosting = false;
      connection.latest = doc;
      connection.heard = true;
      connection.listeners.forEach((listener) => listener(doc));
      return;
    }
    if (frame.kind === "seats") {
      const answer = frame as SeatsAnswerFrame;
      const settle = connection.pendingSeats.get(answer.requestId);
      if (settle) {
        connection.pendingSeats.delete(answer.requestId);
        settle(answer);
      }
      return;
    }
    if (frame.kind === "seat") {
      const answer = frame as SeatAnswerFrame;
      const settle = connection.pending.get(answer.requestId);
      if (settle) {
        connection.pending.delete(answer.requestId);
        settle(answer);
      }
      return;
    }
    if (frame.kind === "error") {
      /* #1341: superseded -- another device took this seat. Forget it and start over as a visitor. */
      if ((frame as { code?: string }).code === SEAT_SUPERSEDED_CODE) {
        connection.retired = true;
        forgetSeat(room);
        return;
      }
      const reason = (frame as { reason?: string }).reason ?? "room error";
      connection.errors.forEach((onError) => onError(reason));
      return;
    }
    /* #1361: EVERY OTHER KIND GOES ON THE BUS. Chat, presence and the lobby frames each have their listeners;
       a kind nobody listens for is remembered and otherwise ignored, so sharing a port with the log means a
       future frame kind arrives here as nothing rather than as an error the player cannot act on. */
    connection.lastFrame.set(frame.kind, frame);
    connection.frames.get(frame.kind)?.forEach((listener) => listener(frame));
  };

  socket.onerror = () => {
    connection.errors.forEach((onError) => onError("lost the connection to the game server"));
  };

  socket.onclose = () => {
    connection.open = false;
    // #1341: a request the wire dropped is answered as a refusal rather than left hanging.
    connection.pending.forEach((settle) => settle({ kind: "seat", requestId: "", ok: false, reason: "lost the connection to the game server" }));
    connection.pending.clear();
    connection.pendingSeats.forEach((settle) => settle({ kind: "seats", requestId: "", seats: [], reason: "lost the connection to the game server" }));
    connection.pendingSeats.clear();
    /* #1361: COME BACK IF ANYBODY IS STILL LISTENING. The connection object -- and every listener on it --
       survives the socket; only the socket is replaced. A connection nobody is listening to is let go, and
       the next `connect` for the room starts fresh. */
    if (connection.retired || !anybodyListening(connection)) {
      if (connections.get(room) === connection) connections.delete(room);
      return;
    }
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(connection.attempts, 4));
    connection.attempts += 1;
    connection.reconnect = window.setTimeout(() => {
      connection.reconnect = null;
      if (connection.retired || !anybodyListening(connection)) {
        if (connections.get(room) === connection) connections.delete(room);
        return;
      }
      attach(room, connection);
    }, delay);
  };
}

function connect(room: string, claim: string): Connection {
  const existing = connections.get(room);
  if (existing) return existing;

  const connection: Connection = {
    socket: null as unknown as SocketLike, // set by `attach` synchronously below
    claim,
    latest: null,
    heard: false,
    listeners: new Set(),
    errors: new Set(),
    frames: new Map(),
    lastFrame: new Map(),
    standing: new Map(),
    backlog: [],
    open: false,
    pending: new Map(),
    pendingSeats: new Map(),
    reconnect: null,
    attempts: 0,
    retired: false,
    hosting: false,
  };
  connections.set(room, connection);
  attach(room, connection);
  return connection;
}

function sendTo(room: string, claim: string, frame: unknown): void {
  const connection = connect(room, claim);
  const text = JSON.stringify(frame);
  if (connection.open) connection.socket.send(text);
  else connection.backlog.push(text);
}

/* ==================================================================
    #1361: THE BUS -- send a frame, listen for a kind
   ================================================================== */

/** Send any frame on the room's connection, queued until the socket is open. */
export function sendFrame(room: string, claim: string, frame: { kind: string; [field: string]: unknown }): void {
  sendTo(room, claim, frame);
}

/** A frame the server keeps as a per-socket subscription: sent now, and again after every reconnect. Keyed
 *  so a later request under the same key replaces the earlier one. */
export function sendStanding(
  room: string,
  claim: string,
  key: string,
  frame: { kind: string; [field: string]: unknown },
): void {
  const connection = connect(room, claim);
  const text = JSON.stringify(frame);
  connection.standing.set(key, text);
  if (connection.open) connection.socket.send(text);
}

export function dropStanding(room: string, key: string): void {
  connections.get(room)?.standing.delete(key);
}

/** Listen for every frame of `kind` on the room's connection. A late subscriber is handed the last one heard
 *  at once, the way the room document's subscriber is. Returns the unsubscribe. */
export function subscribeFrame<T extends { kind: string }>(
  room: string,
  claim: string,
  kind: T["kind"],
  listener: (frame: T) => void,
  onError?: (message: string) => void,
): () => void {
  const connection = connect(room, claim);
  const set = connection.frames.get(kind) ?? new Set<FrameListener>();
  const wrapped: FrameListener = (frame) => listener(frame as T);
  set.add(wrapped);
  connection.frames.set(kind, set);
  if (onError) connection.errors.add(onError);
  const last = connection.lastFrame.get(kind);
  if (last !== undefined) listener(last as T);
  return () => {
    set.delete(wrapped);
    if (onError) connection.errors.delete(onError);
  };
}

/* ---- #1361a: chat and presence, as the two hooks want them ---- */

export function sendChat(room: string, claim: string, text: string, displayName: string): void {
  const frame: ChatSendRequest = { kind: "chat-send", room, text, displayName };
  sendTo(room, claim, frame);
}

export function subscribeChat(
  room: string,
  claim: string,
  onChat: (messages: RoomChatEntry[]) => void,
  onError?: (message: string) => void,
): () => void {
  return subscribeFrame<ChatFrame>(room, claim, "chat", (frame) => {
    if (frame.room === room) onChat(Array.isArray(frame.messages) ? frame.messages : []);
  }, onError);
}

export function sendPresence(room: string, claim: string, state: PresenceState | null): void {
  const frame: PresenceSetRequest = { kind: "presence-set", room, state };
  sendTo(room, claim, frame);
}

export function subscribePresence(
  room: string,
  claim: string,
  onPresence: (entries: PresenceState[], serverNow?: number) => void,
  onError?: (message: string) => void,
): () => void {
  return subscribeFrame<PresenceFrame>(room, claim, "presence", (frame) => {
    if (frame.room === room) {
      onPresence(
        Array.isArray(frame.entries) ? frame.entries : [],
        typeof frame.now === "number" && Number.isFinite(frame.now) ? frame.now : undefined,
      );
    }
  }, onError);
}

/** Matches `subscribeSandboxRoom`'s contract exactly, down to the unsubscribe function. */
export function subscribeRoomDoc(
  room: string,
  claim: string,
  onRoom: Listener,
  onError?: (message: string) => void,
): () => void {
  const connection = connect(room, claim);
  connection.listeners.add(onRoom);
  if (onError) connection.errors.add(onError);
  /* A LATE SUBSCRIBER IS ANSWERED AT ONCE if the document is already known. Waiting for the next frame
     would leave the waiting room blank until somebody else moved, which in a two-player room can be
     forever -- the other player is waiting for the same thing. */
  if (connection.heard) onRoom(connection.latest);
  return () => {
    connection.listeners.delete(onRoom);
    if (onError) connection.errors.delete(onError);
  };
}

/** Fire-and-forget, matching the Firestore writers' shape: they resolve when the write is accepted, not when
 *  it is visible, and every caller already re-reads through the subscription. */
export function writeRoomDoc(room: string, claim: string, write: RoomDocWrite): void {
  // #1363: a create in flight makes the next `null` document a non-answer, not a verdict.
  if (write.op === "host") connect(room, claim).hosting = true;
  sendTo(room, claim, { kind: "room-write", room, write });
}

/** #1358: a seat request that hears nothing is answered as a refusal rather than left hanging -- a card with
 *  every button greyed and no sentence is the worst outcome a request can have. Generous, because the wire
 *  may be a tunnel. */
export const SEAT_REQUEST_TIMEOUT_MS = 12_000;

/** #1341: one seat request, one answer. */
function askSeat(
  room: string,
  claim: string,
  frame: Omit<SeatPinRequest, "requestId"> | Omit<ClaimSeatRequest, "requestId">,
): Promise<SeatAnswerFrame> {
  const connection = connect(room, claim);
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      if (!connection.pending.has(requestId)) return;
      connection.pending.delete(requestId);
      // eslint-disable-next-line no-console
      console.warn(`[seat] ${frame.kind} for ${room} heard nothing in ${SEAT_REQUEST_TIMEOUT_MS}ms (socket open: ${connection.open})`);
      resolve({ kind: "seat", requestId, ok: false, reason: "The game server did not answer. Check the connection and try again." });
    }, SEAT_REQUEST_TIMEOUT_MS);
    connection.pending.set(requestId, (answer) => {
      window.clearTimeout(timer);
      // eslint-disable-next-line no-console
      console.info(`[seat] ${frame.kind} for ${room}: ${answer.ok ? "ok" : `refused — ${answer.reason ?? ""}`}`);
      resolve(answer);
    });
    const text = JSON.stringify({ ...frame, requestId });
    if (connection.open) connection.socket.send(text);
    else connection.backlog.push(text);
  });
}

/** Set (or, with `currentPin`, change) the PIN on this tab's own seat. */
export function setSeatPin(
  room: string,
  claim: string,
  pin: string,
  currentPin?: string,
): Promise<SeatAnswerFrame> {
  return askSeat(room, claim, { kind: "seat-pin", room, playerId: claim, pin, currentPin });
}

/** Take over `playerId`'s seat with its PIN. On `ok` the caller adopts the id (`adoptSeat`). */
export function claimSeat(
  room: string,
  claim: string,
  playerId: string,
  pin: string,
): Promise<SeatAnswerFrame> {
  return askSeat(room, claim, { kind: "claim-seat", room, playerId, pin });
}

/* Design note #1355: THE LOBBY'S OWN SOCKET. A PIN lookup names no room, and every connection here is keyed by
   one, so the lookup rides a connection to a room that does not exist -- the server answers its `room-hello`
   with `doc: null` and thinks nothing more of it. Reused for the claim that follows a match. */
export const LOBBY_ROOM_KEY = "~lobby";

/** Every seat on the server that carries `pin`. */
export function findSeatsByPin(claim: string, pin: string): Promise<SeatsAnswerFrame> {
  const connection = connect(LOBBY_ROOM_KEY, claim);
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      if (!connection.pendingSeats.has(requestId)) return;
      connection.pendingSeats.delete(requestId);
      resolve({ kind: "seats", requestId, seats: [], reason: "The game server did not answer. Check the connection and try again." });
    }, SEAT_REQUEST_TIMEOUT_MS);
    connection.pendingSeats.set(requestId, (answer) => {
      window.clearTimeout(timer);
      resolve(answer);
    });
    const text = JSON.stringify({ kind: "find-seats", requestId, pin });
    if (connection.open) connection.socket.send(text);
    else connection.backlog.push(text);
  });
}
