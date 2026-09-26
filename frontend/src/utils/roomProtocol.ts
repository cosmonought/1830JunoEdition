// frontend/src/utils/roomProtocol.ts
//
// ==================================================================
//  LIVE-2D: THE SERVER-OWNED ROOM PROTOCOL, AS THE CLIENT SPEAKS IT
// ==================================================================
//
// PURE: types, the join-code reader and the refusal sentences -- no socket, no storage, no window. The server
// (`server/src/rooms/gameRecord.ts`) builds these projections and a server test asserts its types and these agree,
// so the two ends of the wire cannot drift apart silently.
//
// THE WAITING ROOM IS A PROJECTION, NEVER A DOCUMENT. The client used to hold a last-write-wins room document whose
// host, seats, status and variants any tab could rewrite (LIVE-1 B-1..B-7). What it holds now is `RoomView`: the
// server's read-only answer to "what does THIS principal see of THIS game", recomputed per recipient. Every control
// in the waiting room is a named `room-op` the server authorizes against its own record; nothing the client shows
// is authority, and `you` is the only place the client learns who it is at the table.
//
// IDENTIFIERS, AND WHICH ONE IS SHOWN (LIVE-2 §7.2):
//   gameId    `g_…`, the durable key -- routing, reconnect, chat and presence are keyed by it. Never displayed.
//   code      `JUNO-XXXX-XXXX`, the rotatable invite. Displayed; `null` for an outsider of a private room.
//   playerId  `p-…`, this principal's seat in the game (`you.playerId`) -- the log's actor. The client uses it for
//             presentation ("your turn") and NEVER sends it as authority: the server derives the actor itself.

import type { GameVariants } from "../gameEngine/gameVariants";
import type { UndoPolicy } from "../gameEngine/logRevert";
import { GAME_ID_PATTERN } from "../gameEngine/messageSchema";
import type { PresenceState } from "./presence";

export type RoomRole = "host" | "player" | "member" | "viewer";
export type RoomLifecycle = "waiting" | "active" | "completed" | "cancelled" | "expired";
export type RoomVisibility = "public" | "private";

export interface RoomViewPlayer {
  /** The seat's server-minted `player_id`. */
  id: string;
  nickname: string;
  isReady: boolean;
  color?: string;
  /** Whether the seat's principal has a room view open right now. */
  online: boolean;
}

/** LIVE-2 §5.5: the only room shape on the wire, recomputed PER RECIPIENT (the `you` block differs). */
export interface RoomView {
  gameId: string;
  code: string | null;
  joinable: boolean;
  visibility: RoomVisibility;
  status: "waiting" | "playing";
  lifecycle: RoomLifecycle;
  closed: boolean;
  held: boolean;
  hostId: string;
  players: RoomViewPlayer[];
  playerCount: number | null;
  seatCap: number;
  variants: GameVariants;
  createdAtMs: number;
  /** LIVE-2D: the room's undo policy, so the Undo button asks the same question the server does (LIVE-2 §9.2). */
  undoPolicy: UndoPolicy;
  you: {
    role: RoomRole;
    playerId: string | null;
    kicked: boolean;
    canStart: boolean;
  };
}

/** A public list entry: names yes, ids no (beyond gameId and code). */
export interface RoomSummary {
  gameId: string;
  code: string;
  status: "waiting" | "playing";
  hostNickname: string;
  nicknames: string[];
  readyCount: number;
  seated: number;
  seatCap: number;
  playerCount: number | null;
  variants: GameVariants;
  createdAtMs: number;
}

/** One line of a game's transcript. `author` is the speaking seat's `player_id`; `displayName` is that seat's
 *  nickname when it was said (a later rename does not rewrite bylines). */
export interface RoomChatEntry {
  id: string;
  author: string;
  displayName: string;
  text: string;
  /** The server's clock, milliseconds. */
  at: number;
}

/* ---------------------------------------------------------------------------
    FRAMES (LIVE-2 Appendix B)
   --------------------------------------------------------------------------- */

export type RoomOpBody =
  | {
      type: "create";
      visibility: RoomVisibility;
      exactPlayers: number | null;
      variants: GameVariants;
      nickname: string;
      color?: string | null;
      /** Chain-neutral; any non-zero stake is refused `money-games-disabled` in LIVE-2. */
      stake?: string;
    }
  | { type: "join"; code: string; takeSeat: boolean }
  | { type: "take-seat" }
  | { type: "release-seat" }
  | { type: "leave" }
  | { type: "set-ready"; ready: boolean }
  | { type: "set-profile"; nickname?: string; color?: string | null }
  | { type: "set-visibility"; visibility: RoomVisibility }
  | { type: "rotate-code" }
  | { type: "kick"; playerId: string }
  | { type: "transfer-host"; toPlayerId: string }
  | { type: "start-game" }
  | { type: "cancel-room" };

export type RoomOpType = RoomOpBody["type"];

export type RoomAck =
  | { kind: "room-ack"; requestId: string; ok: true; data?: Record<string, unknown> }
  | { kind: "room-ack"; requestId: string; ok: false; code: string; reason: string; retryAfterMs?: number };

/** What a client-side op answer resolves to: the server's ack, or a refusal the link made itself (no answer). */
export type RoomOpResult = { ok: true; data: Record<string, unknown> } | { ok: false; code: string; reason: string };

export interface RoomFrame {
  kind: "room";
  gameId: string;
  view: RoomView;
}

export interface RoomsFrame {
  kind: "rooms";
  rooms: RoomSummary[];
}

export interface ChatFrame {
  kind: "chat";
  gameId: string;
  messages: RoomChatEntry[];
}

export interface PresenceFrame {
  kind: "presence";
  gameId: string;
  entries: PresenceState[];
  /** #1397: the server's clock when it sent this. */
  now?: number;
}

/* ---------------------------------------------------------------------------
    IDENTIFIERS
   --------------------------------------------------------------------------- */

/** The read-aloud alphabet (no 0/O, 1/I/L, 5/S). */
export const JOIN_CODE_ALPHABET = "ABCDEFGHJKMNPQRTUVWXYZ2346789";
/** What a code looks like, for the join box's placeholder and its refusal. */
export const JOIN_CODE_EXAMPLE = "JUNO-7K4M-Q2ZP";

/** The join box's reading of what was typed -- the SAME forgiveness the server applies (case, spaces, hyphens,
 *  an optional `JUNO` prefix), so a code the box accepts is a code the server can look up. `null` when it cannot be
 *  a code at all (the server is still the one that says whether it opens a table). */
export function parseJoinCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 32) return null;
  let body = raw.toUpperCase().replace(/[\s-]+/g, "");
  if (body.startsWith("JUNO")) body = body.slice(4);
  if (body.length !== 8) return null;
  for (const symbol of body) if (!JOIN_CODE_ALPHABET.includes(symbol)) return null;
  return `JUNO-${body.slice(0, 4)}-${body.slice(4)}`;
}

/** Whether `value` is a server-minted game id -- the only thing a stored resume pointer may hold. */
export function isGameId(value: unknown): value is string {
  return typeof value === "string" && GAME_ID_PATTERN.test(value);
}

/* ---------------------------------------------------------------------------
    REFUSALS, AS A PLAYER READS THEM (LIVE-2D §20)
   --------------------------------------------------------------------------- */

/** The codes after which this room is not coming back for this tab: stop reconnecting, say so, offer the lobby. */
export const ROOM_LOST_CODES: ReadonlySet<string> = new Set(["not-found", "gone", "kicked"]);

/** Concise sentences for the server's refusal codes. The server's own sentence is preferred where it is a
 *  player-facing sentence (the waiting room's start refusal names what the table is short of); an internal failure
 *  never shows its reference to a player -- it is logged for support instead. */
export function refusalMessage(code: string, reason?: string): string {
  /* A server sentence passed through below never carries a support reference to the screen. */
  const serverReason = typeof reason === "string" ? reason.replace(/\s*\(ref [0-9A-Z]{6}\)/g, "") : undefined;
  switch (code) {
    case "invalid-or-expired":
      return "That code does not open a table right now. Check it with the host — codes change when a host rotates them.";
    case "not-found":
      return "That table is not available to you. It may be private, or it may no longer exist.";
    case "gone":
      return "That table has closed.";
    case "room-full":
      return "That table is full.";
    case "kicked":
      return "The host removed you from that table. You cannot rejoin it.";
    case "rate-limited":
      return "Too many attempts too quickly. Wait a moment and try again.";
    case "limit-reached":
      return serverReason && /tables?/.test(serverReason) ? serverReason : "You are already at as many open tables as a player may be.";
    case "wrong-state":
      return serverReason && serverReason !== "That cannot be done at this point in the game." ? serverReason : "That cannot be done at this point in the game.";
    case "not-ready":
      return serverReason ?? "The table is not ready to start.";
    case "forbidden":
      return "You cannot do that at this table.";
    case "not-seated":
      return "You do not have a seat in this game.";
    case "held":
    case "incompatible":
      return "This game is paused on the server. It cannot continue until the server is updated.";
    case "money-games-disabled":
      return "Games with stakes are not open on this server.";
    case "color-taken":
      return "Another player has that colour.";
    case "bad-frame":
      return serverReason && !/frame/.test(serverReason) ? serverReason : "The server did not accept that request.";
    case "unavailable":
    case "busy":
    case "retry":
    case "timeout":
      return serverReason && code !== "timeout" ? serverReason : "The game server did not answer. Check the connection and try again.";
    case "session-ended":
      /* LIVE-2E: no one plays unprofiled -- "Continue" leads to the profile gate, not to somebody new. */
      return "Your session on this browser has ended. Sign in to your profile again to play.";
    case "profile-required":
      /* LIVE-2E: a room frame from a browser with no profile (the upgrade refuses those before any frame). */
      return "Sign in to a profile to play.";
    case "internal":
      return "Something went wrong on the server. Try again.";
    default:
      return "The server could not do that. Try again.";
  }
}

/** A refusal's support reference, when the server gave one -- for the console, never the screen. */
export function supportRefOf(reason: string | undefined): string | null {
  const match = typeof reason === "string" ? /\(ref ([0-9A-Z]{6})\)/.exec(reason) : null;
  return match ? match[1] : null;
}

/** A server sentence made fit for the screen: its support reference (if any) goes to the console, never the page. */
export function withoutSupportRef(reason: string): string {
  const ref = supportRefOf(reason);
  // eslint-disable-next-line no-console
  if (ref !== null) console.warn(`[game server] refused (ref ${ref})`);
  return reason.replace(/\s*\(ref [0-9A-Z]{6}\)/g, "");
}
