// frontend/src/utils/lobbyProtocol.ts
//
// The staging lobby's records and the frames that carry them. A LEAF: the server imports these shapes, and
// `lobby.ts` (hooks, React) re-exports the document types from here so nothing on the server side has to
// reach into a file that imports React.
//
// ==================================================================
//  DESIGN NOTE 1361b: THE STAGING LOBBY MOVES TO THE GAME SERVER
// ==================================================================
//
// The pre-game staging rooms (`games/{roomId}` and their `seats/` in Firestore) were the last Firestore
// listeners in the app once #1215 moved the sandbox roster and #1213 the log. Firestore's test-mode window
// closed and every listener became a CORS error, so the record moves to the server that already holds
// everything else, over the socket that already carries the room document (#1215).
//
// THE SHAPES ARE UNCHANGED. `RoomDoc` and `SeatDoc` are exactly what `Lobby.tsx` rendered from Firestore, so
// the screen does not change; only where the fields come from does. Every mutation `lobby.ts` used to perform
// as a Firestore transaction is a NAMED WRITE here, applied by the server under the rule it carried:
//
//   create-room     mints an id, seats the host (the one place a seat is created is still `claim-seat`).
//   claim-seat      capacity-checked and idempotent for a wallet that already holds a seat.
//   release-seat    deletes the seat and decrements the counter in one step.
//   set-ready / set-display-name / mark-on-chain / heartbeat   patch one seat, stamping `lastSeen`.
//   set-status      the host's launching / staging / closed transitions, with the launch error.
//   bind-chain-game-id   write-once, flips the room live.
//
// `lastSeenMs` IS THE SERVER'S CLOCK, as `serverTimestamp()` was. `derivePresence` compares seats against the
// NEWEST stamp in the room rather than the local clock (lobby.ts #1), and that reasoning needs every stamp to
// come from one clock. The server is that clock now.

import type { GameVariants } from "./gameVariants";

export type RoomStatus = "staging" | "launching" | "live" | "closed";

/** One row in the room-discovery list. */
export interface RoomDoc {
  /** The server's room id. NOT the on-chain game id -- see `chainGameId`. */
  id: string;
  name: string;
  hostAddress: string;
  hostDisplayName: string;
  maxPlayers: number;
  /** Maintained by the server alongside the seats -- the capacity check reads it. */
  seatCount: number;
  status: RoomStatus;
  /** The `u64` the CONTRACT assigned, parsed from `CreateGameRoom`'s `game_id` tx attribute. `null` until the
   *  host launches. A pointer, not state: write-once, and only ever used as the argument to a real on-chain
   *  query. */
  chainGameId: number | null;
  /** The exact `ujuno` deposit every player must attach, as a base-denom INTEGER STRING -- never a number,
   *  since `Uint128` overflows a JS double. */
  anteUjuno: string;
  /** `CreateGameRoom { virtual_bank_start }`, integer string, same reason. */
  virtualBankStart: string;
  /** Design note #902: the house rules, resolved. */
  variants: GameVariants;
  createdAtMs: number;
  /** Surfaced to every player in the room, not just the host, so a failed launch explains itself. */
  launchError: string | null;
}

/** One claimed seat. The player's `juno1...` address IS the key, which is what makes a double claim by the
 *  same wallet structurally impossible. */
export interface SeatDoc {
  address: string;
  displayName: string;
  ready: boolean;
  isHost: boolean;
  /** Whether this player has completed their on-chain ante. */
  onChain: boolean;
  joinedAtMs: number;
  /** The server's clock, milliseconds. `null` never arrives from the server; the type keeps `derivePresence`'s
   *  "pending write" branch, which an optimistic local echo may still take. */
  lastSeenMs: number | null;
}

/** The server's whole record of one staging room. */
export interface StagingRoomRecord {
  room: RoomDoc;
  seats: SeatDoc[];
}

export interface CreateRoomWrite {
  op: "create-room";
  name: string;
  maxPlayers: number;
  hostAddress: string;
  hostDisplayName: string;
  anteUjuno: string;
  virtualBankStart: string;
  variants: GameVariants;
}

export type LobbyWrite =
  | CreateRoomWrite
  | { op: "claim-seat"; roomId: string; address: string; displayName: string; asHost: boolean }
  | { op: "release-seat"; roomId: string; address: string }
  | { op: "set-ready"; roomId: string; address: string; ready: boolean }
  | { op: "set-display-name"; roomId: string; address: string; displayName: string }
  | { op: "mark-on-chain"; roomId: string; address: string }
  | { op: "heartbeat"; roomId: string; address: string }
  | { op: "set-status"; roomId: string; status: RoomStatus; launchError: string | null }
  | { op: "bind-chain-game-id"; roomId: string; chainGameId: number };

/* ---- client -> server ---- */

/** Subscribe to the room list. Answered with a `lobby` frame and every change after it. */
export interface LobbyHelloRequest {
  kind: "lobby-hello";
}

/** Watch one room and its seats (`null` to stop). Answered with a `lobby-room` frame and every change after. */
export interface LobbyWatchRequest {
  kind: "lobby-watch";
  roomId: string | null;
}

export interface LobbyWriteRequest {
  kind: "lobby-write";
  requestId: string;
  write: LobbyWrite;
}

/* ---- server -> client ---- */

export interface LobbyFrame {
  kind: "lobby";
  rooms: RoomDoc[];
}

export interface LobbyRoomFrame {
  kind: "lobby-room";
  roomId: string;
  room: RoomDoc | null;
  seats: SeatDoc[];
}

export interface LobbyAckFrame {
  kind: "lobby-ack";
  requestId: string;
  ok: boolean;
  reason?: string;
  /** On `create-room`: the id the server minted. */
  roomId?: string;
}

/** How many rooms the list carries. The same bound the Firestore query had. */
export const ROOM_LIST_LIMIT = 60;
