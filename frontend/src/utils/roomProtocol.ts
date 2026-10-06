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
import type { MyTableMoneySummary, RoomMoneyView, RoomStakeSummary } from "./moneyProtocol";
import type { ClockDeadlineClass, RoomClockView } from "./clockProtocol";
import type { PresenceState } from "./presence";

export type RoomRole = "host" | "player" | "member" | "viewer";
export type RoomLifecycle = "waiting" | "active" | "completed" | "cancelled" | "expired";
export type RoomVisibility = "public" | "private";
/** LIVE-3C: why a room will not take a change, as the server says it (`null`: it will).
 *    maintenance   held by the server: paused until its operator restores it; the seat and the game so far are kept
 *    incompatible  this server does not continue the game (LIVE-4: its rules or game-server protocol, a money table's
 *                  escrow, or a server that has handed its games over): it cannot continue here
 *    read-only     NO LONGER SENT (LIVE-4 L4-2): it was "dealt on another server build"; a build no longer decides
 *                  whether a game continues. Kept so a view from an older server still reads
 *    unavailable   the server could not confirm its last write: paused until it can, or it restarts */
export type RoomHoldKind = "maintenance" | "incompatible" | "read-only" | "unavailable" | null;

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
  /** LIVE-3C: why the room will not take a change (`null`: it will). */
  holdKind: RoomHoldKind;
  /** LIVE-4 (L4-3), additive and optional: with `holdKind: "incompatible"`, the server's own sentence for WHY it does
   *  not continue (or no longer serves) the game -- the `incompatible` frame's `reason` -- so the standing notice says
   *  the actual reason (a rules version, a game-server protocol, an escrow this server does not serve, a newer server
   *  that took the game over) instead of one sentence for all of them. Absent otherwise, and from an older server. */
  holdReason?: string;
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
  /** ESCROW-4 (additive, optional): a real-money table's projection for this viewer (`moneyProtocol.ts`). Absent for a
   *  no-money table (and from any server that has no money layer). */
  money?: RoomMoneyView;
  /** Phase 3 final clocks (additive, optional): the table clock (`clockProtocol.ts`) -- the deadline, who owes the next
   *  required decision and their countdown, a train offer's response time, an overdue, votes, pauses, a system pause.
   *  Absent before the table has a clock and from an older server. The browser presents it; the server decides. */
  clock?: RoomClockView;
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
  /** ESCROW-4 (additive, optional): a real-money table's stake badge. Absent for a no-money table. */
  stake?: RoomStakeSummary;
}

/** LIVE-2F/3D (C9-01): one of the caller's own tables ("Your tables"), answered to `room-op {type:"my-tables"}` on the
 *  lobby channel. The server's `MyTableSummary` (`server/src/rooms/gameRecord.ts`), field for field: no principal id,
 *  no code -- only what a seated player already sees, and the game id that reopens the table. LIVE-4 (L4-2): a server no
 *  longer sends `watch-only` (a table dealt on another build); a table it does not continue is `cannot-continue`. */
export type MyTableState = "waiting" | "playing" | "finished" | "resume" | "paused" | "unavailable" | "cannot-continue" | "watch-only";

export interface MyTableSummary {
  gameId: string;
  state: MyTableState;
  visibility: RoomVisibility;
  hostNickname: string;
  nicknames: string[];
  you: "host" | "player";
  createdAtMs: number;
  lastActivityMs: number;
  /** ESCROW-4 (additive, optional): this seat's money line at a real-money table. Absent otherwise. */
  money?: MyTableMoneySummary;
}

const MY_TABLE_STATES: ReadonlySet<string> = new Set(["waiting", "playing", "finished", "resume", "paused", "unavailable", "cannot-continue", "watch-only"]);

/** The tables in a `my-tables` answer, keeping only well-formed entries (a game id the client will open, a known
 *  state); anything else is dropped rather than guessed at. */
export function myTablesOf(data: Record<string, unknown>): MyTableSummary[] {
  const tables = Array.isArray(data.tables) ? data.tables : [];
  return tables.filter((entry): entry is MyTableSummary => {
    if (typeof entry !== "object" || entry === null) return false;
    const table = entry as Record<string, unknown>;
    return (
      typeof table.gameId === "string" &&
      isGameId(table.gameId) &&
      typeof table.state === "string" &&
      MY_TABLE_STATES.has(table.state) &&
      (table.visibility === "public" || table.visibility === "private") &&
      typeof table.hostNickname === "string" &&
      Array.isArray(table.nicknames) &&
      table.nicknames.every((name) => typeof name === "string") &&
      (table.you === "host" || table.you === "player") &&
      typeof table.createdAtMs === "number" &&
      typeof table.lastActivityMs === "number" &&
      /* ESCROW-4: a money line is an object, or absent (no money; an older server never sends one). */
      (table.money === undefined || (typeof table.money === "object" && table.money !== null && !Array.isArray(table.money)))
    );
  });
}

/** What "Your tables" says a table is, and what its button says. */
export function myTableLabel(state: MyTableState): { status: string; action: string } {
  switch (state) {
    case "waiting":
      return { status: "Waiting to start", action: "Return to table" };
    case "playing":
      return { status: "Under way", action: "Return to table" };
    case "resume":
      return { status: "Under way", action: "Return to table" };
    case "finished":
      return { status: "Finished", action: "View final board" };
    case "paused":
      return { status: "Paused for maintenance", action: "Open" };
    case "unavailable":
      return { status: "Temporarily unavailable", action: "Try again" };
    case "cannot-continue":
      return { status: "Cannot continue on this server", action: "Open" };
    case "watch-only":
      return { status: "Watch only (another server build)", action: "Watch" };
  }
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
      /** ESCROW-4: a real-money table's gross ante per seat, in the deployment's base units (a canonical decimal).
       *  The server refuses it `money-games-disabled` unless it has real-money tables enabled. */
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
  | { type: "cancel-room" }
  /** Phase 3 final clocks (`clockProtocol.ts` CLOCK_OPS): the table clock's ops. */
  | { type: "clock-policy"; deadline: ClockDeadlineClass; paceSecs?: number | null }
  | { type: "clock-pause"; action: "request" | "yes" | "no"; kind: "pause" | "resume"; id?: number }
  | { type: "clock-sysresume" }
  | { type: "clock-propose"; kind: "foreclose" | "annul"; approveUntil?: number; signature?: string }
  | { type: "clock-vote"; proposalId: number; yes: boolean; approveUntil?: number; signature?: string }
  | { type: "clock-annul"; yes: boolean }
  | { type: "clock-ack" }
  /** LIVE-2F/3D (C9-01): a read -- the caller's own tables, answered `{tables: MyTableSummary[]}`. */
  | { type: "my-tables" };

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
      /* LIVE-3C: the server says what ended the table (cancelled, expired, archived) -- one of its fixed sentences. */
      return serverReason !== undefined && (GONE_REASONS as readonly string[]).includes(serverReason) ? serverReason : "That table has closed.";
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
    /* LIVE-3C: a held game and an incompatible one are different things to a player: one waits for the operator,
       the other cannot continue on this server at all. */
    case "held":
      return HOLD_NOTICES.maintenance;
    case "incompatible":
      return HOLD_NOTICES.incompatible;
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

/* ---------------------------------------------------------------------------
    LIVE-3C: A ROOM THAT WILL NOT TAKE A CHANGE, AS A PLAYER READS IT
   --------------------------------------------------------------------------- */

/** One sentence per `RoomView.holdKind`: what happened, what is kept, and what (if anything) will change it. */
export const HOLD_NOTICES = Object.freeze({
  maintenance:
    "This game is paused for maintenance. Nothing can change until the server's operator restores it; your seat and the game so far are kept.",
  /* LIVE-4 (L4-2): generalized -- a rules version, a game-server protocol, a money table's escrow, a handed-over game. */
  incompatible:
    "This game was started on a version of the game this server does not run. It is kept exactly as it was, but it cannot continue on this server.",
  "read-only":
    "This game was dealt on a different server build. You can watch it, but it cannot be continued here: run the build that dealt it, or start a new game.",
  unavailable: "The game server could not confirm the last move was recorded. The game is paused until it can; the move will appear if it was made.",
} as const);

/** The server's fixed sentences for a table that is gone (`server/src/rooms/lifecycle.ts` `GONE_SENTENCES`). */
export const GONE_REASONS = Object.freeze([
  "The host closed this table before the game started.",
  "This table expired: it waited 24 hours without starting.",
  "This game has been archived and is no longer open.",
] as const);

/** The longest server sentence a standing notice shows (the server's are one or two sentences). */
const MAX_HOLD_REASON_LENGTH = 400;

/** The standing notice a room's view calls for, or `null` when it will take a change. LIVE-4 (L4-3): an incompatible
 *  game's notice is the server's own sentence for why (`holdReason`) when the view carries one -- the same words its
 *  `incompatible` frame says -- and the general sentence otherwise. */
export function holdNoticeFor(view: Pick<RoomView, "holdKind" | "holdReason"> | null | undefined): string | null {
  const kind = view?.holdKind ?? null;
  if (kind === "incompatible") {
    const reason = typeof view?.holdReason === "string" ? view.holdReason.replace(/\s*\(ref [0-9A-Z]{6}\)/g, "").trim() : "";
    if (reason.length > 0 && reason.length <= MAX_HOLD_REASON_LENGTH) return reason;
  }
  /* A kind this client does not know (a newer server) shows nothing rather than an empty notice. */
  return kind === null ? null : (HOLD_NOTICES[kind] ?? null);
}

/* ---------------------------------------------------------------------------
    LIVE-4 (L4-3): THE GAME LINK'S "CANNOT CONTINUE HERE" BANNER SAYS THE ACTUAL REASON
   --------------------------------------------------------------------------- */

/** The `incompatible` reasons that ARE the game's rules pin (#1520): the only ones whose banner names rules versions.
 *  An older server (before LIVE-4 L4-2) sent no reason code at all -- and its only `incompatible` was the rules pin. */
export const RULES_PIN_REASONS: ReadonlySet<string> = new Set(["rules-not-supported", "legacy-unpinned"]);

/**
 * The banner for a game the server does not continue (the log link's `incompatible`, or a route this tab could not
 * follow): the server's own sentence for the reason, and -- ONLY when the rules pin is the reason -- the pinned and
 * supported rules versions after it, as #1520 wrote them. A game held for its hosted protocol, an escrow this server
 * does not serve, a drain, a newer server's take-over or a stale tab never reads "Pinned rules version: 11; this server
 * supports 11" (L4-2's finding): that line would name a version that is not the problem.
 */
export function incompatibleNotice(input: { reason: string; why?: string; pinned: number | null; supported: readonly number[] }): string {
  const sentence = (typeof input.reason === "string" ? input.reason.replace(/\s*\(ref [0-9A-Z]{6}\)/g, "").trim() : "") || HOLD_NOTICES.incompatible;
  const rulesAreTheReason = input.why === undefined || RULES_PIN_REASONS.has(input.why);
  if (!rulesAreTheReason) return sentence;
  return `${sentence} (Pinned rules version: ${input.pinned ?? "none"}; this server supports ${input.supported.join(", ")}.)`;
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
