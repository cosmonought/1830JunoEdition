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
import type { SandboxRoomDoc, SandboxRoomPlayer, SandboxRoomStatus } from "./sandboxRoom";

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

interface Connection {
  socket: SocketLike;
  /** The last document the server sent. Handed to a late subscriber immediately, so a component that mounts
   *  after the first frame is not left waiting for a change that may never come. */
  latest: SandboxRoomDoc | null;
  /** Whether anything has arrived yet. #764's distinction: "no such room" and "have not heard" differ, and
   *  the waiting room gates its own not-knowing on the first snapshot. */
  heard: boolean;
  listeners: Set<Listener>;
  errors: Set<(message: string) => void>;
  backlog: string[];
  open: boolean;
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
  connections.forEach((connection) => connection.socket.close());
  connections.clear();
}

function connect(room: string, claim: string): Connection {
  const existing = connections.get(room);
  if (existing) return existing;

  const socket = socketFactory(GAME_SERVER_URL ?? "");
  const connection: Connection = {
    socket,
    latest: null,
    heard: false,
    listeners: new Set(),
    errors: new Set(),
    backlog: [],
    open: false,
  };

  socket.onopen = () => {
    connection.open = true;
    socket.send(
      JSON.stringify({ kind: "room-hello", room, build: CLIENT_BUILD_ID, claim }),
    );
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
      connection.latest = doc;
      connection.heard = true;
      connection.listeners.forEach((listener) => listener(doc));
      return;
    }
    if (frame.kind === "error") {
      const reason = (frame as { reason?: string }).reason ?? "room error";
      connection.errors.forEach((onError) => onError(reason));
    }
    /* ANY OTHER FRAME IS NOT THIS SOCKET'S BUSINESS AND IS IGNORED. This connection said `room-hello`, so
       the server sends it room frames -- but sharing a port with the log means a future frame kind would
       otherwise arrive here as an error the player cannot act on. */
  };

  socket.onerror = () => {
    connection.errors.forEach((onError) => onError("lost the connection to the game server"));
  };

  socket.onclose = () => {
    connection.open = false;
    connections.delete(room);
  };

  connections.set(room, connection);
  return connection;
}

function sendTo(room: string, claim: string, frame: unknown): void {
  const connection = connect(room, claim);
  const text = JSON.stringify(frame);
  if (connection.open) connection.socket.send(text);
  else connection.backlog.push(text);
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
  sendTo(room, claim, { kind: "room-write", room, write });
}
