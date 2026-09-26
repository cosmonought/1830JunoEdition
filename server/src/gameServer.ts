// server/src/gameServer.ts
//
// The process that hosts rooms. Everything it knows how to decide lives elsewhere.
//
// ==================================================================
//  DESIGN NOTE 1210: THE TRANSPORT DECIDES NOTHING
// ==================================================================
//
// THIS FILE IS DELIBERATELY THIN, and its thinness is the point rather than a stage it will grow out of.
// `RoomSession` gates, applies, appends and answers (#1209); `turnAuthority` says who may act (#1205);
// `RoomEngine` settles the board (#1201). What is left here is sockets, a room registry, and fan-out.
//
// IF A RULE EVER APPEARS IN THIS FILE IT IS IN THE WRONG PLACE. A rule the transport knows is a rule the
// replay harness cannot execute, the CLI cannot check, and the golden master cannot cover -- which is the
// exact property that made `App.tsx` the authority for so long, and the whole reason for this migration.
//
// ---------------------------------------------------------------------------
//  IDENTITY, AND WHY THIS FILE REFUSES TO GUESS AT IT
// ---------------------------------------------------------------------------
//
// EVERYTHING BUILT IN PHASE 2 RESTS ON THE SERVER KNOWING WHO IS SPEAKING. #1207 keeps the actor off the
// wire precisely so a client cannot claim to be somebody else, and `turnAuthority` then refuses actions on
// the strength of that identity. A transport that accepted a claimed id would quietly undo both, and it
// would do so while every test still passed.
//
// SO `resolveIdentity` IS REQUIRED AND HAS NO DEFAULT. There is no fallback that trusts the connection,
// because a fallback is what gets reached for at four in the afternoon. `trustClaimedIdentity` below exists
// for local play, is named to be embarrassing in a diff, and shouts on every connection.

import { randomBytes } from "crypto";
import { createServer, type Server as HttpServer } from "http";
import { WebSocketServer, type WebSocket } from "ws";

import { RoomSession, type ServerLogEntry } from "../../frontend/src/utils/roomSession";
import {
  DEVELOPMENT_CORPUS_POLICY,
  SERVER_REPLAY_POLICY,
  SUPPORTED_RULES_ENGINE_VERSIONS,
  type ReplayPolicy,
} from "../../frontend/src/gameEngine/rulesVersion";
/* #1500: the game machine, through its front door. Everything this server knows about 1830 comes from
   `frontend/src/gameEngine` -- one import, one surface, and no second implementation of any rule. */
import {
  DEFAULT_SANDBOX_SCENARIO,
  STANDARD_VARIANTS,
  effectiveActions,
  logHash,
  sandboxReplayProviders,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
  validateSubmitEnvelope,
  waterfallForRoster,
  withEmptyRoster,
} from "../../frontend/src/gameEngine";
/* LIVE-2A: the closed control frames, the recursive gameplay parse, and the one text sanitizer. */
import {
  SUBMISSION_ID_PATTERN,
  parseClientFrame,
  parseGameplayMessage,
  sanitizeName,
  sanitizeText,
} from "../../frontend/src/gameEngine/messageSchema";
import { dealEntryOf, revertTargetOf } from "../../frontend/src/gameEngine/logRevert";
import type { ServerFrame, ServerMessage } from "../../frontend/src/utils/serverProtocol";
import type { SandboxLogMsg } from "../../frontend/src/gameEngine/gameSetup";
import type {
  ChatSendRequest,
  PresenceSetRequest,
  RoomChatEntry,
  RoomDocWrite,
} from "../../frontend/src/utils/roomDocLink";
import type { PresenceState } from "../../frontend/src/utils/presence";
import type {
  LobbyHelloRequest,
  LobbyWatchRequest,
  LobbyWriteRequest,
  RoomDoc,
  SeatDoc,
  StagingRoomRecord,
} from "../../frontend/src/utils/lobbyProtocol";
import { ROOM_LIST_LIMIT } from "../../frontend/src/utils/lobbyProtocol";
import type { SandboxRoomDoc, SandboxRoomPlayer } from "../../frontend/src/utils/sandboxRoom";
/* #1415: the room's terms -- values, from the pure module (`sandboxRoom.ts` itself is type-only here because it
   imports the browser's socket). */
import {
  normaliseAnte,
  normalisePlayerCount,
  roomSeatCap,
  roomVisibility,
  summariseSandboxRoom,
  type SandboxRoomSummary,
} from "../../frontend/src/utils/sandboxRoomSummary";
import type { LogStore } from "./fileLogStore";
import { COMMITTED, outcomeOf } from "./persistence/storeResult";
/* LIVE-3A: every mutation of a game runs on that game's actor, and every read comes from its committed view. */
import {
  GameActor,
  HELD_REASON,
  UNAVAILABLE_REASON,
  newActorCounters,
  type ActorCounters,
  type BatchSettlement,
  type DocSettlement,
  type GameFaults,
  type GameStorePort,
  type Subscriber,
  type TaskOrigin,
  type Tx,
} from "./rooms/gameActor";
import { GameRegistry } from "./rooms/gameRegistry";
/* LIVE-2A: the transport's limits and buckets (LIVE-2 §11.3, §12.2). */
import {
  HourlyBudget,
  SocketBuckets,
  excerpt,
  resolveLimits,
  type BucketName,
  type IngressLimitOverrides,
} from "./ingress/limits";

/** Resolves the player behind a connection, or `null` to reject it.
 *
 *  ASYNC BECAUSE A REAL ONE WILL BE -- a signature check or a session lookup. Making the shape right now
 *  costs nothing and stops the eventual implementation from being a refactor of every caller. */
export type ResolveIdentity = (input: {
  claim: unknown;
  headers: Record<string, string | string[] | undefined>;
}) => Promise<string | null>;

/** Local-play identity: believes whatever the client says it is.
 *
 *  NOT FOR ANYTHING WITH MONEY IN IT, and the name is chosen so that a reviewer reading a diff cannot miss
 *  what has been wired up. A room using this has no authority worth the word: any client may claim any seat
 *  and `turnAuthority` will faithfully enforce the rules on behalf of the wrong person. */
export const trustClaimedIdentity: ResolveIdentity = async ({ claim }) => {
  const id = typeof claim === "string" && claim !== "" ? claim : null;
  if (id) {
    // eslint-disable-next-line no-console
    console.warn(
      `[INSECURE] accepted a self-declared identity "${id}". Local play only -- see #1210.`,
    );
  }
  return id;
};

interface HelloFrame {
  kind: "hello";
  room: string;
  build: string;
  claim?: unknown;
  /** Design note #1341: the seat PIN, demanded when the claimed seat has one. */
  pin?: unknown;
  /** Design note #1341: the seat's session token; an older one than the seat's latest is superseded. */
  token?: unknown;
  /** What this client has already applied, so a reconnect is answered rather than guessed at. */
  baseIndex?: number;
  /** LIVE-3A (L3-3): the id of the entry the client holds at `baseIndex` -- the anchor. */
  baseId?: unknown;
}

interface SubmitFrame {
  kind: "submit";
  build: string;
  msg: SandboxLogMsg;
  baseIndex: number;
  /** LIVE-3A (L3-3): the anchor, validated by `validateSubmitEnvelope`. */
  baseId?: string;
  submissionId?: string;
}

/* ==================================================================
    DESIGN NOTE 1215: THE WAITING ROOM, AND WHY IT IS NOT THE LOG
   ==================================================================
   The roster used to live on Firestore, and when Firestore went unreachable the table could not be seated:
   `hostSandboxRoom` awaited a write that never landed and the button did nothing at all. `roomDocLink.ts`
   carries the argument in full; what matters HERE is the separation.

   THE LOG IS APPENDED, ORDERED, REPLAYED, HASHED AND SETTLED. THIS IS NONE OF THOSE THINGS. It is
   last-write-wins, it is never replayed, no reducer sees it, and it is thrown away when the game starts for
   real. Keeping it in a different map from `rooms` is what stops that distinction eroding.

   NO RULE MAY BE DECIDED FROM IT. `turnAuthority` reads the board. If a check ever reaches for the roster to
   answer "may this player act", the answer is being taken from a record any client can overwrite. */
interface RoomHelloFrame {
  kind: "room-hello";
  room: string;
  build: string;
  claim?: unknown;
  /** Design note #1341: the seat PIN, demanded when the claimed seat has one. */
  pin?: unknown;
  /** Design note #1341: the seat's session token; an older one than the seat's latest is superseded. */
  token?: unknown;
}

interface RoomWriteFrame {
  kind: "room-write";
  room: string;
  write: RoomDocWrite;
}

/* ==================================================================
    DESIGN NOTE 1341: THE SEAT PIN, SERVER SIDE
   ==================================================================
   `sandboxRoom.ts` #1341 is the design. Here: two frames on the room-doc socket, one gate on both hellos.
     seat-pin    the socket's OWN seat sets its PIN; changing one needs the current one.
     claim-seat  any socket takes over a seat by giving its PIN. A seat that HAS one must be given that one.
                 A seat that has none ADOPTS the PIN offered (#1341a) -- the migration path for seats claimed
                 before the PIN existed. Read the addendum at the branch before relying on this: an unPINned
                 seat is first-come, and that is a property of the seat having no PIN, not of this branch.
     the gate    a `hello` or `room-hello` claiming an id that has a PIN must carry it, or is refused and
                 closed. This is what makes the PIN protect a seat rather than merely decorate it: the
                 identity resolver still believes the claim (#1210), the PIN is the one fact it checks.
   ON A SUCCESSFUL CLAIM the log sockets attached to that actor in that room are told they were SUPERSEDED and
   closed -- "gracefully close the old connection" -- and a fresh SESSION TOKEN is minted for the seat and
   handed to the claimant. Both devices know the PIN from then on, so the PIN alone cannot keep the old one
   out when its socket reconnects on a backoff; the token can. A hello carrying a stale token is refused with
   the same superseded code, and the client's answer to that code is to forget the seat and reload as a
   visitor (`seatPin.ts`). Tokens are in memory only: a restart lets any device with the PIN back in.
   PLAIN STRINGS, in the room document, persisted with it, and stripped from every broadcast by `publicDoc`.
   Ruled so for closed playtests: no hashing, a key to one room's seat and to nothing else. */
interface SeatPinFrame {
  kind: "seat-pin";
  room: string;
  requestId: string;
  playerId: string;
  pin: unknown;
  currentPin?: unknown;
}

interface ClaimSeatFrame {
  kind: "claim-seat";
  room: string;
  requestId: string;
  playerId: string;
  pin: unknown;
}

/* LIVE-2A (LIVE-2 §10.5, §15 #6): `find-seats` -- DESIGN NOTE 1355, "A PIN FINDS ITS SEATS" -- IS DELETED. It
   answered any socket, before any hello, with every seat on the server carrying a four-digit PIN: an oracle that
   enumerated all 10,000 PINs in 0.65 s (LIVE-1). The frame kind is no longer recognised (`bad-frame`), and the
   lobby's PIN-first card is gone with it. A new device rejoins its seat by room code and PIN (#1352) until LIVE-2E's
   transfer codes replace PINs altogether. */

/* ==================================================================
    DESIGN NOTE 1361: CHAT, PRESENCE AND THE STAGING LOBBY, ON THE ROOM-DOC SOCKET
   ==================================================================
   Firestore's test-mode window closed and the three records that had stayed there -- the transcript, the
   route-presence hints and the parked on-chain staging lobby -- became CORS errors. They move here, onto the
   socket that already carries the room document, and #1215's separation is the rule for all of them: NONE OF
   THIS IS THE LOG. Nothing here is appended, replayed, hashed or settled; no rule is decided from any of it.
     chat        (#1361a) one transcript per room, capped, persisted as a sidecar, broadcast whole.
     presence    (#1361a) one current value per seat, in memory only, cleared when the socket closes.
     the lobby   (#1361b) the staging rooms and their seats, persisted whole; every write is a named op the
                 server applies under the rule its Firestore transaction used to carry.
   THE ACTOR IS THE CONNECTION'S, for chat and presence -- the same posture as the log (#1207): a chat line
   is stamped with who the socket said it was at `room-hello`, and a presence write can only ever set the
   sender's own seat. The lobby writes carry a wallet address in the frame because that lobby is keyed by
   wallet and the socket is keyed by player id; it is the parked Web3 path, believed the way the local
   identity is believed (#1210). */
interface ChatSendFrame extends ChatSendRequest {}
interface PresenceSetFrame extends PresenceSetRequest {}
interface LobbyHelloFrame extends LobbyHelloRequest {}
interface LobbyWatchFrame extends LobbyWatchRequest {}
interface LobbyWriteFrame extends LobbyWriteRequest {}

type ClientFrame =
  | HelloFrame
  | SubmitFrame
  | RoomHelloFrame
  | RoomWriteFrame
  | SeatPinFrame
  | ClaimSeatFrame
  | ChatSendFrame
  | PresenceSetFrame
  | LobbyHelloFrame
  | LobbyWatchFrame
  | LobbyWriteFrame;

/* ==================================================================
    LIVE-0: THE STAGING LOBBY IS PARKED ON THE SERVER TOO
   ==================================================================
   #525 parked the on-chain staging lobby's UI behind `WEB3_LOBBY_ENABLED` (`Lobby.tsx`), but this process
   kept answering its frames -- unauthenticated, a wallet address believed from the frame, and a first-writer
   `bind-chain-game-id` (LIVE-1 B-6). Parked here the same way: one constant, nothing deleted. The escrow
   integration replaces it properly; until then no staging room can be read or written through this server.
   `lobby-hello` STAYS ANSWERED, because it is also the subscription the PUBLIC SANDBOX ROOM LIST rides
   (#1415, `useSandboxRooms`). Its `rooms` frame is live; only its staging `lobby` frame is parked, as an
   empty list. `lobby-watch` is answered with no room and watches nothing. `lobby-write` is refused in its
   own `lobby-ack`, applies nothing and saves nothing, so `lobby.json` is never rewritten.
   EACH REFUSAL IS THE FRAME ITS CALLER ALREADY LISTENS FOR, NOT AN `error`. `roomDocLink.ts` fans an `error`
   out to every error listener on the lobby socket -- the Join Game list's among them -- and `Lobby.tsx`
   renders those banners outside the Web3 gate, so a refusal sent as `error` would put a red banner on the
   live lobby. */
const STAGING_LOBBY_ENABLED: boolean = false;
const STAGING_LOBBY_PARKED_REASON = "The on-chain staging lobby is switched off on this server.";

/** #1361a: how much of a transcript a room keeps and sends. Mirrors `CHAT_HISTORY_LIMIT` in `ChatBox.tsx`. */
const CHAT_HISTORY_LIMIT = 200;
const MAX_CHAT_MESSAGE_LENGTH = 500;
const MAX_DISPLAY_NAME_LENGTH = 24;

const isValidSeatPin = (pin: unknown): pin is string => typeof pin === "string" && /^[0-9]{4}$/.test(pin);
const SEAT_SUPERSEDED_CODE = "seat-superseded";
/** #1346: a hello turned away for a seat reason -- a wrong or missing PIN. Terminal for the client: retrying
 *  the same hello cannot change the answer, so it must not loop. */
const SEAT_REFUSED_CODE = "seat-refused";
/** #1415: a room write the document did not take (full table, kicked seat, a kick by a non-host). */
const ROOM_WRITE_REFUSED_CODE = "room-write-refused";
const mintSeatToken = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/** The document as the wire sees it: `seatPins` stripped, `hasPin` stamped on each seat. */
const publicDoc = (doc: SandboxRoomDoc | null): SandboxRoomDoc | null => {
  if (!doc) return null;
  const { seatPins, ...rest } = doc;
  return {
    ...rest,
    players: doc.players.map((player) => ({ ...player, hasPin: Boolean(seatPins?.[player.id]) })),
  };
};

/* ==================================================================
    LIVE-0: LOOPBACK ONLY
   ==================================================================
   `http.listen(port)` with no host binds EVERY interface -- the local network, and anything else routed to
   this machine -- while the startup line said `127.0.0.1` (LIVE-1 B-8). Nothing on the playtest path needs
   more than loopback: two tabs here connect to 127.0.0.1, and a tunnelled playtest reaches this server only
   through `playtest-proxy.js`, which runs on this machine and forwards to 127.0.0.1. So it binds loopback,
   and `start.ts` prints this same constant, so the banner cannot say one thing while the socket does
   another. Where a deployment binds is LIVE-5's question, deliberately not a flag here. */
export const GAME_SERVER_BIND_HOST = "127.0.0.1";

export interface GameServerOptions {
  port: number;
  build: string;
  resolveIdentity: ResolveIdentity;
  /* ==================================================================
      DESIGN NOTE 1250: THE STORE IS AWAITED BEFORE ANYBODY IS TOLD
     ==================================================================
     Where a room's history lives. In memory when absent -- a test, the smoke run -- and on disk through
     `fileLogStore.ts` in `start.ts`. The append is awaited between `session.submit` and the answer, so the
     `applied` frame and the fan-out both describe entries the disk has synced; a write the store DEFINITELY did
     not take rolls the session back and the submitter is told `retry`, because a move the disk does not hold did
     not happen (#1209, read literally) -- and one whose outcome the store could not settle holds the room
     (LIVE-3B). The room document is saved through the same store, before it is published, and loaded with the
     log, so a restart restores a game whose roster still has names. */
  store?: LogStore;
  /** #1225: send per-field digests with every answer so a diverged client can name the field itself. A
   *  local-play diagnostic; `start.ts` turns it on wherever it turns on the insecure identity, because those
   *  are the same situation. */
  explainDivergence?: boolean;
  /** #1520: whether a stored room dealt BEFORE rules-engine versioning (no `rules_engine_version` on its
   *  deal) may be loaded under this engine. `"refuse"` when absent -- the deployment answer: such a room is
   *  held and every client is told. `"development-corpus"` is `start.ts`'s `--legacy-logs` opt-in for the
   *  local playtest rooms, announced at startup and again per room. A room pinned to a version this server
   *  does not carry is held under either setting. */
  legacyLogs?: ReplayPolicy["legacyLogs"];
  /** Called when entries become durable and visible, inside the publish that shows them (LIVE-3A). */
  onAppend?: (room: string, entries: readonly ServerLogEntry[]) => void;
  /** Test-only fault injection for the LIVE-3A regressions (LIVE-3D generalises it). Never set by `start.ts`. */
  faults?: GameFaults;
  /** LIVE-3B E-11: the store-call timeout inside an actor task (5 s when absent) and how long a late write may stay
   *  unsettled before a restart is asked for (60 s). Tests shorten both. */
  storeTimeoutMs?: number;
  storeRestartAfterMs?: number;
  /** LIVE-3B: a game holds a store outcome only a process restart can resolve (a write whose redo failed, or one
   *  that never settled). `start.ts` fails fast; without it the game simply stays held. */
  onRestartRequired?: (room: string, detail: string) => void;
  /** LIVE-2A: the transport's limits (LIVE-2 §11.3, §12.2), each overridable -- tests shorten the clocks and shrink
   *  the caps; `start.ts` takes the defaults. See `ingress/limits.ts`. */
  limits?: IngressLimitOverrides;
}

interface Attached {
  room: string;
  actor: string;
}

/* ==================================================================
    LIVE-3A: THE SENTENCES THE TRANSPORT OWNS
   ================================================================== */
/** §4.1: the store definitely did not take the move (nothing past the committed history), so it was not made. */
const RECORD_FAILED_REASON = "The server could not record that move, so it was not made. Try again.";
/** E-7: the game's queue is full. */
const BUSY_REASON = "The game server is busy with this game. Try again in a moment.";
/** E-8: the task was never run -- its deadline passed while it waited behind other work. */
const EXPIRED_REASON = "The game server did not get to that move in time, so it was not made. Try again.";
/** A room that could not be loaded from the store. */
const LOAD_FAILED_REASON = "The game server could not load this room right now. It will keep trying.";
/** F-10: a room document the store did not take. */
const ROOM_SAVE_FAILED_REASON = "The server could not record that change to the room, so it was not made. Try again.";
/** LIVE-3B (§8.7): a room document whose save could not be confirmed either way; the room is held for a restart. */
const ROOM_SAVE_UNCONFIRMED_REASON =
  "The server could not confirm that change to the room was recorded. The room is paused until the server restarts.";
const docRefusal = (settled: DocSettlement): string =>
  settled.kind === "unresolved" ? ROOM_SAVE_UNCONFIRMED_REASON : ROOM_SAVE_FAILED_REASON;
/** E-9: a reference ties the sentence a player reads to the line in this window (LIVE-2 §11.5). */
const REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const errorRef = (): string => Array.from(randomBytes(6), (byte) => REF_ALPHABET[byte % 32]).join("");

/* ==================================================================
    LIVE-2A (LIVE-2 §11.4, §11.5): WHAT A MALFORMED OR THROWING FRAME IS TOLD
   ==================================================================
   A fixed sentence, never the frame's own text, never an exception's message: the reference ties the sentence a
   player reads to the full line in this window. */
const BAD_FRAME_CODE = "bad-frame";
const RATE_LIMITED_CODE = "rate-limited";
const INTERNAL_REASON = (ref: string) => `The server could not process that request. (ref ${ref})`;
const MOVE_INTERNAL_REASON = (ref: string) => `The server could not process that move, so it was not made. (ref ${ref})`;
const RATE_LIMITED_REASON = "Too many requests too quickly. Wait a moment and try again.";
const SUBMIT_RATE_LIMITED_REASON = "You are sending moves too quickly. Wait a moment and try again.";
const REVERT_BUDGET_REASON = "Too many undos in the last hour. Play on, and undo again later.";
const LOG_FULL_REASON = "This game has reached the server's limit on its length and cannot take another move.";
/** LIVE-2A (LIVE-2 §13.4 step 1): `host` over a room that already exists. The client picks a fresh code. */
const ROOM_CODE_TAKEN_CODE = "room-code-taken";
const ROOM_CODE_TAKEN_REASON = "That room code is already in use.";

/** A direct answer to a submit names the submission it answers (L3-3); fan-out never does. */
const answering = <T extends object>(message: T, inReplyTo: string | undefined): T =>
  inReplyTo === undefined ? message : { ...message, inReplyTo };

/** LIVE-2A: the submission a frame names, for `inReplyTo` -- only when it is a well-formed, bounded id, so a reply
 *  never carries a stranger's arbitrary text back. */
const submissionIdOf = (frame: unknown): string | undefined => {
  const id = typeof frame === "object" && frame !== null ? (frame as { submissionId?: unknown }).submissionId : undefined;
  return typeof id === "string" && SUBMISSION_ID_PATTERN.test(id) ? id : undefined;
};

export function createGameServer(options: GameServerOptions): {
  http: HttpServer;
  close: () => Promise<void>;
  /** LIVE-3A: the executor's counters (expiries, store failures, resyncs...), for tests and the smoke run. */
  counters: Readonly<ActorCounters & { submitAhead: number; submitResync: number; internal: number }>;
  /** LIVE-2A: what the ingress limits refused, stripped and closed -- for tests and the smoke run. */
  ingress: Readonly<{
    badFrames: number;
    malformedClosed: number;
    rateLimited: number;
    rateLimitedByBucket: Readonly<Partial<Record<BucketName, number>>>;
    rateLimitClosed: number;
    pendingOverflowClosed: number;
    slowConsumerClosed: number;
    keepaliveTerminated: number;
    stripped: number;
    logFull: number;
    revertBudgetRefused: number;
    internal: number;
  }>;
  /** LIVE-2A: the limits this server runs with. */
  limits: Readonly<ReturnType<typeof resolveLimits>>;
} {
  /** Who each LOG socket said it was at `hello`, and which room. Identity only: the subscription itself lives on
   *  the room's actor (LIVE-3A), which is what fan-out reads. */
  const sockets = new Map<WebSocket, Attached>();
  /** #1215. A separate map from the log on purpose: this one holds no history and decides nothing.
   *
   *  LIVE-3A: THE COMMITTED DOCUMENTS, AND ONLY THOSE. An entry changes here in exactly two places -- the
   *  single-flight load below, which fills a room nobody has read yet, and the publish of a room-authority task
   *  on the room's actor, after the store has taken the document (F-10). It is the committed view's `roomDoc`,
   *  kept by code so the public list and the PIN lookup can read a room without loading its game. */
  const roomDocs = new Map<string, SandboxRoomDoc>();
  const roomDocSockets = new Map<WebSocket, string>();
  /** #1341: who each room-doc socket said it was, so a seat-pin write can be checked against its own seat. */
  const roomDocActors = new Map<WebSocket, string>();
  /** #1341: the latest session token per seat, by room then player id. In memory only. */
  const seatTokens = new Map<string, Map<string, string>>();
  const tokenFor = (code: string, playerId: string) => seatTokens.get(code)?.get(playerId);
  const setToken = (code: string, playerId: string, token: string) => {
    const room = seatTokens.get(code) ?? new Map<string, string>();
    room.set(playerId, token);
    seatTokens.set(code, room);
  };
  /* LIVE-2A: the transport's limits, and what they have refused. */
  const limits = resolveLimits(options.limits);
  const ingress = {
    badFrames: 0,
    malformedClosed: 0,
    rateLimited: 0,
    rateLimitedByBucket: {} as Partial<Record<BucketName, number>>,
    rateLimitClosed: 0,
    pendingOverflowClosed: 0,
    slowConsumerClosed: 0,
    keepaliveTerminated: 0,
    stripped: 0,
    logFull: 0,
    revertBudgetRefused: 0,
    internal: 0,
  };
  /** LIVE-2A (§12.2): reverts per seat per hour -- `${room}\u0000${actor}` -> own actions and others'. In memory;
   *  a restart forgets it, which costs at most one more hour's budget. */
  const revertBudgets = new Map<string, { self: HourlyBudget; others: HourlyBudget }>();
  const revertBudgetFor = (room: string, actor: string, which: "self" | "others"): HourlyBudget => {
    const key = `${room}\u0000${actor}`;
    let entry = revertBudgets.get(key);
    if (entry === undefined) {
      entry = {
        self: new HourlyBudget(limits.selfRevertsPerHour, () => Date.now()),
        others: new HourlyBudget(limits.hostRevertsOfOthersPerHour, () => Date.now()),
      };
      revertBudgets.set(key, entry);
    }
    return entry[which];
  };
  /** Rooms whose log has passed the alarm length, said once each (LIVE-2 §12.2: alarm at 5,000). */
  const logAlarmed = new Set<string>();
  let minted = 0;
  /* #1250: A PROCESS TAG ON EVERY MINTED ID. `id` is an entry's identity -- `effectiveActions` kills reverted
     entries by it (#1026) -- and a counter that restarts at 1 with the process would mint an id a stored log
     already holds. The tag makes ids unique across restarts; the counter inside it keeps #1238's evidence
     (a new tag says "restarted" the way `s58` said "did not"). */
  const processTag = Date.now().toString(36);

  /* #1250: the document is loaded once per room, and thereafter lives in the map.
     LIVE-3A: SINGLE-FLIGHT, and read AFTER the wait. The old version marked a room loaded before its read had
     finished, so a second caller in the meantime was answered `null` -- a PIN gate that found no PIN (the LIVE-3
     verifier's caveat) -- and it wrote whatever it read over the map, however stale. Now every caller for a room
     waits on the one read, and each answers with the map as it stands when the wait ends, which is never older
     than anything already published to a socket that was registered before it asked. */
  const roomDocKnown = new Set<string>();
  const roomDocLoads = new Map<string, Promise<void>>();
  async function roomDocFor(code: string): Promise<SandboxRoomDoc | null> {
    if (!roomDocKnown.has(code)) {
      let load = roomDocLoads.get(code);
      if (load === undefined) {
        load = (async () => {
          try {
            const stored = await options.store?.loadRoomDoc(code);
            if (stored && !roomDocs.has(code)) roomDocs.set(code, stored);
            roomDocKnown.add(code);
          } finally {
            roomDocLoads.delete(code);
          }
        })();
        roomDocLoads.set(code, load);
      }
      await load;
    }
    return roomDocs.get(code) ?? null;
  }

  /** A room's session at the seed, nothing applied: what a game is loaded into. */
  const newRoomSession = (): RoomSession =>
    new RoomSession({
      providers: sandboxReplayProviders(),
      seed: {
        state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
        waterfall: waterfallForRoster(
          sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true),
          [],
        ),
      },
      build: options.build,
      /* #1026's transactional allocation was a fix for RACING BROWSERS. One writer needs no transaction, and
         an id only has to be unique within a room -- the index already carries the ordering. */
      mintId: () => `s${processTag}-${(minted += 1)}`,
      now: () => Date.now(),
      explainDivergence: options.explainDivergence === true,
      replayPolicy: options.legacyLogs === "development-corpus" ? DEVELOPMENT_CORPUS_POLICY : SERVER_REPLAY_POLICY,
    });

  /** A stored log into a session, said in the window. */
  const restoreRoom = (code: string, session: RoomSession, stored: readonly ServerLogEntry[]): void => {
    /* RESTORED THROUGH `apply`, NEVER `submit` (#1203): a stored log already holds its derived entries. */
    session.restore(stored);
    // eslint-disable-next-line no-console
    console.log(
      `  restored ${code}: ${stored.length} entries from the store, log hash ${logHash(stored).slice(0, 16)}… (#1251)`,
    );
    /* #1252: said once here, and again in every refusal -- a room this server cannot continue is a room
       somebody will try to continue. */
    const dealt = session.dealtBuild();
    if (dealt !== null && dealt !== options.build) {
      // eslint-disable-next-line no-console
      console.warn(
        `  ${code} was dealt on build "${dealt}"; this server is "${options.build}" and will refuse to continue it (#1252)`,
      );
    }
    /* #1520: A HELD ROOM, SAID ONCE HERE. `restore` did not interpret a single entry: the deal names a
       rules-engine version this server does not carry (or names none -- a legacy log, which this server
       refuses rather than guesses at). The log on disk is exactly as it was found; every hello and every
       submit on this room is answered `incompatible` until a server with the pinned version loads it. */
    const held = session.incompatible;
    if (held === null && session.replayCompatibility().kind === "legacy") {
      // eslint-disable-next-line no-console
      console.warn(
        `  ${code} is a LEGACY room (its deal carries no rules_engine_version) admitted under --legacy-logs ` +
          `development-corpus and replayed with engine version(s) [${SUPPORTED_RULES_ENGINE_VERSIONS.join(", ")}]. ` +
          `A deployment refuses this room (#1520).`,
      );
    }
    if (held !== null) {
      const pinned = held.compatibility.kind === "incompatible" ? String(held.compatibility.version) : "none (legacy)";
      // eslint-disable-next-line no-console
      console.warn(
        `  ${code} is HELD, not rebuilt: pinned rules-engine version ${pinned}, this server supports ` +
          `[${SUPPORTED_RULES_ENGINE_VERSIONS.join(", ")}] (#1520). ${held.reason}`,
      );
    }
  };

  /* LIVE-2A (§11.3, §12.2): A SLOW CONSUMER IS CLOSED, NOT BUFFERED FOREVER. A socket that has stopped reading
     would otherwise hold every fan-out frame in this process's memory; past the cap it is closed 1013 and sent
     nothing more. */
  const slowConsumers = new WeakSet<WebSocket>();
  const send = (socket: WebSocket, message: ServerFrame | object) => {
    if (socket.readyState !== socket.OPEN || slowConsumers.has(socket)) return;
    if (socket.bufferedAmount > limits.maxOutboundBufferedBytes) {
      slowConsumers.add(socket);
      ingress.slowConsumerClosed += 1;
      // eslint-disable-next-line no-console
      console.warn(`  ingress: closed a slow consumer (${socket.bufferedAmount} bytes unsent) -- 1013`);
      socket.close(1013, "slow consumer");
      return;
    }
    socket.send(JSON.stringify(message));
  };

  /* ==================================================================
      LIVE-3A: ONE ACTOR PER GAME, AND THE STORE BEHIND IT
     ==================================================================
     `roomFor` is gone. A game is reached through `games.get`, which creates its actor once however many frames
     ask at the same moment (LIVE-3 P2), and every change to it -- a move, a room write, a PIN -- is a task on that
     actor (`rooms/gameActor.ts`). The store is today's `LogStore`, seen through the port the actor commits to;
     without one (a test, the smoke run) the game lives in memory, exactly as before. */
  const counters = { ...newActorCounters(), submitAhead: 0, submitResync: 0, internal: 0 };
  const store = options.store;
  /* LIVE-3B: WRITES ANSWER WITH A CLASS -- committed, definitely not, or uncertain (persistence/storeResult.ts). A
     store with the classified methods (the file store) is asked directly; a legacy store that only resolves or
     rejects is read conservatively: a rejection is uncertain unless it threw `StoreDefiniteError`. */
  const storePort: GameStorePort = {
    loadLog: async (code) => (store ? await store.loadLog(code) : []),
    appendBatch: async (code, entries) => {
      if (!store || entries.length === 0) return COMMITTED;
      if (store.appendBatch) return store.appendBatch(code, entries);
      try {
        await store.appendLog(code, entries);
        return COMMITTED;
      } catch (error) {
        return outcomeOf(error);
      }
    },
    loadRoomDoc: async (code) => (store ? await store.loadRoomDoc(code) : null),
    saveRoomDoc: async (code, doc) => {
      if (!store) return COMMITTED;
      if (store.replaceRoomDoc) return store.replaceRoomDoc(code, doc);
      try {
        await store.saveRoomDoc(code, doc);
        return COMMITTED;
      } catch (error) {
        return outcomeOf(error);
      }
    },
  };
  const games = new GameRegistry({
    evictable: store !== undefined,
    now: () => Date.now(),
    create: (code) =>
      new GameActor({
        gameId: code,
        build: options.build,
        explainDivergence: options.explainDivergence === true,
        store: storePort,
        newSession: newRoomSession,
        restore: (session, stored) => restoreRoom(code, session, stored),
        loadRoomDoc: () => roomDocFor(code),
        /* The committed document, published: the map is the view's document, set in the publish itself. */
        onRoomDocPublished: (doc) => {
          roomDocs.set(code, doc as SandboxRoomDoc);
          roomDocKnown.add(code);
        },
        onEntriesPublished: (entries) => options.onAppend?.(code, entries),
        now: () => Date.now(),
        // eslint-disable-next-line no-console
        warn: (line) => console.warn(line),
        counters,
        faults: options.faults,
        storeTimeoutMs: options.storeTimeoutMs,
        storeRestartAfterMs: options.storeRestartAfterMs,
        onRestartRequired: (gameId, detail) => options.onRestartRequired?.(gameId, detail),
      }),
  });

  /** A task's origin: the socket, who it said it was, and -- for a submit -- the nonce `inFlight` reports. */
  const originFor = (socket: WebSocket, principal: string, submissionId?: string): TaskOrigin => ({
    key: socket,
    principal,
    submissionId,
    isOpen: () => socket.readyState === socket.OPEN,
    send: (frame) => send(socket, frame),
  });

  /** A log subscriber: the same socket, seen as a reader of the room's committed history. */
  const subscriberFor = (socket: WebSocket, principal: string): Subscriber => ({
    principal,
    isOpen: () => socket.readyState === socket.OPEN,
    send: (frame) => send(socket, frame),
  });

  /** Which actor each log socket is subscribed to, so a second hello -- a resync, or another room -- replaces the
   *  subscription rather than adding one, and a close removes it. */
  const logSubscriptions = new Map<WebSocket, GameActor>();
  const unsubscribeLog = (socket: WebSocket) => {
    logSubscriptions.get(socket)?.unsubscribe(socket);
    logSubscriptions.delete(socket);
  };

  /** #1215. Applies one named write and hands back the document, or `null` if the room does not exist yet
   *  and this write was not the one that creates it.
   *
   *  LIVE-3A: PURE. It hands back the PROSPECTIVE document and changes nothing: the caller is a task on the
   *  room's actor, which makes the document durable and only then publishes it (F-10). Called only inside that
   *  task, where `roomDocs` holds the committed document the task started from (E-2).
   *
   *  EVERY OP MIRRORS A FIRESTORE WRITER ONE FOR ONE, including the rule each carried. The upsert is the one
   *  with a rule worth restating: an existing player is replaced IN PLACE (#541), because `toSetupPlayers`
   *  reads this order to build the deal and a filter-and-append would move a player to the back of the table
   *  every time they typed a character of their name. */
  /* ==================================================================
      DESIGN NOTE 1415 (server): THE TABLE'S TERMS ARE ENFORCED WHERE EVERY WRITE PASSES
     ==================================================================
     ASKED: the host sets the table before the room exists -- exactly N players or any, public or private, an
     ante -- and may remove a joiner; the server "refuses join past N".
     THREE RULES, ALL HERE, because this is the one place every write goes through (#1337 made the same point
     about colours). A NEW joiner is refused when the table is full, when the room is no longer waiting, or when
     the host removed them -- a kicked player who could rejoin by refreshing was not kicked. An EXISTING seat's
     upsert (a rename, a Ready) is never refused by the cap: they already hold the seat. The `kick` op is gated on
     the WRITER -- `roomDocActors` knows who each socket said it was, and only the host's word removes anybody --
     and on the room still waiting, since a seat in a dealt game is a roster the log has already read.
     A REFUSAL IS A RESULT, NOT A SILENT DROP. The writer is told why; the document is unchanged. */
  type RoomWriteResult = {
    doc: SandboxRoomDoc | null;
    refused?: string;
    /** LIVE-2A: a `host` over a room that exists -- answered `room-code-taken`, and the room is not re-sent. */
    codeTaken?: boolean;
    /** LIVE-2A: a `status` write the server's own derivation leaves unchanged -- answered to the writer alone. */
    echo?: boolean;
  };

  /* ==================================================================
      LIVE-2A (LIVE-2 §13.4 step 1): THE LEGACY WRITES, HARDENED IN PLACE
     ==================================================================
     The room document stays last-write-wins until LIVE-2C replaces it with a server-owned record, but the writes
     that let one client rewrite another's table are closed now:
       host           creates a room and never overwrites one (LIVE-1 probe A: `host` took over any room). The
                      writer must be the host it names. A taken code is answered `room-code-taken`, and the
                      client picks a fresh one (up to five times, `sandboxRoom.ts`).
       upsert-player  the writer's OWN seat only (`player.id === actor`, §15 #4); a new seat is refused once the
                      room is dealt -- read off the committed log, not off the document's `status`.
       status         a server-derived echo: the server sets `playing` itself when the deal is committed
                      (`markPlayingAfterDeal`); a client's `playing` is answered with the room as the log makes
                      it, and any other value is refused (§15 #12). LIVE-2D deletes the op.
       variants,      DELETED (LIVE-2 §9.1, §9.4). The variants are fixed when the room is hosted; forced-sign was
       forced-sign    a playtest waiver a pinned table never honours. Neither is in the frame schema: `bad-frame`.
     Nicknames pass through the single sanitizer (§11.2) and are capped at 24 (§11.3). */
  const applyRoomWrite = (
    code: string,
    write: RoomDocWrite,
    actor: string | undefined,
    dealt: boolean,
  ): RoomWriteResult => {
    const existing = roomDocs.get(code) ?? null;

    if (write.op === "host") {
      if (existing) return { doc: existing, refused: ROOM_CODE_TAKEN_REASON, codeTaken: true };
      if (!actor || write.hostId !== actor) return { doc: null, refused: "A room is hosted by the player who opens it." };
      /* #527: every room opens in the anteroom with its host already seated, so the roster is never briefly
         empty in a room that plainly has somebody in it. */
      const variants = write.variants ?? STANDARD_VARIANTS;
      const created: SandboxRoomDoc = {
        code,
        hostId: write.hostId,
        status: "waiting",
        players: [{ id: write.hostId, nickname: sanitizeName(write.nickname, MAX_DISPLAY_NAME_LENGTH) || "Host", isReady: false }],
        variants,
        forcedSign: null,
        /* #1415: validated, not cast -- untrusted wire data. */
        visibility: write.visibility === "private" ? "private" : "public",
        playerCount: normalisePlayerCount(write.playerCount, variants),
        anteUjuno: normaliseAnte(write.anteUjuno),
        createdAtMs: Date.now(),
        kicked: [],
      };
      return { doc: created };
    }

    /* A WRITE TO A ROOM NOBODY HOSTED IS DROPPED, not made to create one. A room whose `hostId` was invented
       from whoever wrote first would hand the Start button to an arbitrary player. */
    if (!existing) return { doc: null };

    let next: SandboxRoomDoc;
    switch (write.op) {
      case "upsert-player": {
        /* LIVE-2A (§15 #4): A SEAT IS WRITTEN BY ITS OWN PLAYER. Anybody could rename, ready or un-ready any seat
           by naming its id (LIVE-1 probe C). */
        if (!actor || write.player.id !== actor) {
          return { doc: existing, refused: "You can only change your own seat." };
        }
        const at = existing.players.findIndex((entry) => entry.id === write.player.id);
        if (at === -1) {
          if (existing.kicked?.includes(write.player.id)) {
            return { doc: existing, refused: "The host removed you from this table." };
          }
          if (existing.status !== "waiting" || dealt) {
            return { doc: existing, refused: "This game has already started." };
          }
          if (existing.players.length >= roomSeatCap(existing)) {
            return { doc: existing, refused: `This table is full (${roomSeatCap(existing)} seats).` };
          }
        }
        /* The seat as stored: the declared fields only (`hasPin` is the server's own stamp, never a client's), the
           nickname through the single sanitizer. */
        const incoming: SandboxRoomPlayer = {
          id: write.player.id,
          nickname: sanitizeName(write.player.nickname, MAX_DISPLAY_NAME_LENGTH),
          isReady: write.player.isReady === true,
          ...(typeof write.player.color === "string" ? { color: write.player.color } : {}),
        };
        /* Design note #1337: A COLOUR ANOTHER SEAT HOLDS IS NOT TAKEN -- first write wins. The client greys
           out held swatches, but two clicks in flight at once both see a free swatch; the server is the one
           place both writes pass through, so the second keeps whatever colour it had before. */
        const wanted = incoming.color;
        const heldElsewhere =
          typeof wanted === "string" &&
          existing.players.some((entry, index) => index !== at && entry.color === wanted);
        const player = heldElsewhere
          ? (() => {
              const { color: _refused, ...rest } = incoming;
              const previous = at === -1 ? undefined : existing.players[at].color;
              return previous === undefined ? rest : { ...rest, color: previous };
            })()
          : incoming;
        next = {
          ...existing,
          players:
            at === -1
              ? [...existing.players, player]
              : existing.players.map((entry, index) => (index === at ? player : entry)),
        };
        break;
      }
      case "status": {
        /* LIVE-2A (§15 #12, the NO-OP ECHO): the status is the server's to set. `playing` is answered with the room
           as the committed log makes it -- `playing` once dealt, which also repairs a document a crash left
           `waiting` behind a durable deal -- and nothing else is a value a client may write. */
        if (write.status !== "playing") return { doc: existing, refused: "The room's status is set by the server." };
        if (dealt && existing.status === "waiting") {
          next = { ...existing, status: "playing" };
          break;
        }
        return { doc: existing, echo: true };
      }
      case "kick": {
        if (!actor || actor !== existing.hostId) return { doc: existing, refused: "Only the host can remove a player." };
        if (existing.status !== "waiting" || dealt) return { doc: existing, refused: "Players cannot be removed once the game has started." };
        if (write.playerId === existing.hostId) return { doc: existing, refused: "The host cannot remove themselves." };
        if (!existing.players.some((entry) => entry.id === write.playerId)) return { doc: existing };
        next = {
          ...existing,
          players: existing.players.filter((entry) => entry.id !== write.playerId),
          kicked: [...(existing.kicked ?? []), write.playerId],
        };
        break;
      }
      default:
        /* `variants`, `forced-sign` (deleted) and anything else: the frame schema refuses them first. */
        return { doc: existing, refused: "That is not a room write this server accepts." };
    }

    return { doc: next };
  };

  /** Everyone watching this room's document, the writer included -- unlike the log's fan-out, where the
   *  submitter's own answer is a different message. Here there is no answer: the document IS the answer. */
  const broadcastRoomDoc = (code: string) => {
    const doc = publicDoc(roomDocs.get(code) ?? null);
    for (const [socket, watching] of roomDocSockets) {
      if (watching === code) send(socket, { kind: "room", room: code, doc } as never);
    }
  };

  /** #1341: the PIN and token gate for both hellos. `null` when the claim may proceed, else the refusal. */
  const seatRefusal = async (
    code: string,
    actor: string,
    offeredPin: unknown,
    offeredToken: unknown,
  ): Promise<{ reason: string; code?: string } | null> => {
    const required = (await roomDocFor(code))?.seatPins?.[actor];
    if (!required) return null;
    if (required !== offeredPin) {
      return { reason: "This seat has a PIN. Rejoin it from the room screen with the PIN.", code: SEAT_REFUSED_CODE };
    }
    const latest = tokenFor(code, actor);
    if (latest && latest !== offeredToken) {
      return { reason: "This seat is now on another device.", code: SEAT_SUPERSEDED_CODE };
    }
    return null;
  };

  /* LIVE-3A: `saveRoomDocQuietly` is gone. It saved AFTER the document had already changed in memory and
     swallowed a failure, so a PIN or a seat could be shown, believed by the next hello, and silently lost at the
     next restart (LIVE-3 F-10). A seat write is now a task that commits the document before anybody sees it. */

  /* ---- #1361a: chat ---- */
  const roomChats = new Map<string, RoomChatEntry[]>();
  const chatLoaded = new Set<string>();
  async function chatFor(code: string): Promise<RoomChatEntry[]> {
    if (!chatLoaded.has(code)) {
      chatLoaded.add(code);
      if (!roomChats.has(code)) {
        try {
          const stored = (await options.store?.loadChat?.(code)) ?? [];
          roomChats.set(code, stored.slice(-CHAT_HISTORY_LIMIT));
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(`  store: could not load the transcript for ${code}`, error);
        }
      }
    }
    return roomChats.get(code) ?? [];
  }
  let chatMinted = 0;
  const broadcastChat = (code: string) => {
    const messages = roomChats.get(code) ?? [];
    for (const [socket, watching] of roomDocSockets) {
      if (watching === code) send(socket, { kind: "chat", room: code, messages } as never);
    }
  };

  /* ---- #1361a: presence ---- */
  const presence = new Map<string, Map<string, PresenceState>>();
  /* #1397: STAMPED ON THIS CLOCK, SENT WITH THIS CLOCK. A presence entry's `at` decides on every other screen
     whether the entry is fresh, and it was the sender's wall clock compared against the reader's -- two
     machines that need only disagree by six seconds for one player's routes to be invisible to another for
     the whole game. The server overwrites `at` on receipt and sends its own `now` with every frame, so a
     reader measures age as (server now - server at) and rebases into its own clock. No clock is compared
     with any other. */
  const presenceFrame = (code: string) => ({
    kind: "presence",
    room: code,
    now: Date.now(),
    entries: [...(presence.get(code)?.values() ?? [])],
  });
  const broadcastPresence = (code: string) => {
    const frame = presenceFrame(code);
    for (const [socket, watching] of roomDocSockets) {
      if (watching === code) send(socket, frame as never);
    }
  };

  /* ---- #1361b: the staging lobby ---- */
  const stagingRooms = new Map<string, StagingRoomRecord>();
  const lobbySockets = new Set<WebSocket>();
  const lobbyWatch = new Map<WebSocket, string>();
  const lobbyReady: Promise<void> = (async () => {
    try {
      for (const record of (await options.store?.loadLobby?.()) ?? []) {
        if (record?.room?.id) stagingRooms.set(record.room.id, record);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("  store: could not load the staging lobby", error);
    }
  })();
  const saveLobbyQuietly = async () => {
    if (!options.store?.saveLobby) return;
    try {
      await options.store.saveLobby([...stagingRooms.values()]);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("  store: could not save the staging lobby", error);
    }
  };
  /** Newest first, closed rooms omitted, bounded -- the query the Firestore list used to run. */
  const lobbyRooms = (): RoomDoc[] =>
    [...stagingRooms.values()]
      .map((record) => record.room)
      .filter((room) => room.status !== "closed")
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, ROOM_LIST_LIMIT);
  const broadcastLobby = () => {
    const rooms = lobbyRooms();
    for (const socket of lobbySockets) send(socket, { kind: "lobby", rooms } as never);
  };
  /* ---- #1415: the PUBLIC sandbox room list ---- the one Join Game shows. Every room the server holds or the
     store remembers, public, newest first; a private room is never listed. Loads every stored document once
     (`roomDocFor` caches), so a restart re-lists the tables it was holding. */
  const sandboxRooms = async (): Promise<SandboxRoomSummary[]> => {
    const codes = new Set<string>(roomDocs.keys());
    try {
      for (const code of (await options.store?.listRooms?.()) ?? []) codes.add(code);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("  store: could not list rooms for the public list", error);
    }
    const out: SandboxRoomSummary[] = [];
    for (const code of codes) {
      const doc = await roomDocFor(code);
      /* The FIELD, not the reader's default: a room from before this note never chose to be listed, and the
         store holds every finished playtest -- none of which belongs on the Ongoing tab. */
      if (!doc || doc.visibility !== "public") continue;
      out.push(summariseSandboxRoom(doc));
    }
    return out.sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, ROOM_LIST_LIMIT);
  };
  const broadcastSandboxRooms = async () => {
    if (lobbySockets.size === 0) return;
    const rooms = await sandboxRooms();
    for (const socket of lobbySockets) send(socket, { kind: "rooms", rooms } as never);
  };
  const broadcastLobbyRoom = (roomId: string) => {
    const record = stagingRooms.get(roomId) ?? null;
    const frame = { kind: "lobby-room", roomId, room: record?.room ?? null, seats: record?.seats ?? [] };
    for (const [socket, watching] of lobbyWatch) {
      if (watching === roomId) send(socket, frame as never);
    }
  };
  let lobbyMinted = 0;
  const mintLobbyRoomId = () => `r${processTag}-${(lobbyMinted += 1)}`;
  const cleanName = (raw: unknown, limit: number) =>
    typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, limit) : "";

  /** Applies one lobby write. EVERY OP MIRRORS A FIRESTORE WRITER ONE FOR ONE, including the rule each
   *  carried: the capacity check and the seat write are one step; releasing decrements the counter; the
   *  chain id is write-once. `lastSeenMs` is this process's clock -- the one clock `derivePresence` needs. */
  const applyLobbyWrite = (write: LobbyWriteFrame["write"]): { ok: boolean; reason?: string; roomId?: string } => {
    const now = Date.now();
    const stamp = (seat: SeatDoc, patch: Partial<SeatDoc>): SeatDoc => ({ ...seat, ...patch, lastSeenMs: now });

    if (write.op === "create-room") {
      const id = mintLobbyRoomId();
      const room: RoomDoc = {
        id,
        name: cleanName(write.name, 48) || "Untitled room",
        hostAddress: String(write.hostAddress ?? ""),
        hostDisplayName: cleanName(write.hostDisplayName, MAX_DISPLAY_NAME_LENGTH),
        maxPlayers: Number.isFinite(write.maxPlayers) ? Math.round(write.maxPlayers) : 6,
        seatCount: 0,
        status: "staging",
        chainGameId: null,
        anteUjuno: /^\d+$/.test(String(write.anteUjuno)) ? String(write.anteUjuno) : "0",
        virtualBankStart: /^\d+$/.test(String(write.virtualBankStart)) ? String(write.virtualBankStart) : "0",
        variants: write.variants ?? STANDARD_VARIANTS,
        createdAtMs: now,
        launchError: null,
      };
      stagingRooms.set(id, { room, seats: [] });
      /* Separate step, not part of the create: the claim is the ONE place a seat is ever created, so its
         capacity accounting cannot drift from a second inlined copy here. */
      const seated = applyLobbyWrite({
        op: "claim-seat",
        roomId: id,
        address: room.hostAddress,
        displayName: room.hostDisplayName,
        asHost: true,
      });
      return seated.ok ? { ok: true, roomId: id } : seated;
    }

    const record = stagingRooms.get(write.roomId);
    if (!record) return { ok: false, reason: "That room no longer exists." };
    const { room, seats } = record;
    const seatAt = "address" in write ? seats.findIndex((seat) => seat.address === write.address) : -1;
    const patchSeat = (patch: Partial<SeatDoc>) => {
      if (seatAt === -1) return { ok: false, reason: "You do not hold a seat in that room." };
      record.seats = seats.map((seat, index) => (index === seatAt ? stamp(seat, patch) : seat));
      return { ok: true };
    };

    switch (write.op) {
      case "claim-seat": {
        if (seatAt !== -1) return patchSeat({ displayName: cleanName(write.displayName, MAX_DISPLAY_NAME_LENGTH) });
        if (room.status !== "staging") {
          return { ok: false, reason: "That room has already launched and is no longer accepting new seats." };
        }
        if (room.seatCount >= room.maxPlayers) return { ok: false, reason: "That room is full." };
        if (!write.address) return { ok: false, reason: "A seat needs an address." };
        record.seats = [
          ...seats,
          {
            address: String(write.address),
            displayName: cleanName(write.displayName, MAX_DISPLAY_NAME_LENGTH),
            ready: write.asHost === true, // the host is implicitly ready; they are the one launching
            isHost: write.asHost === true,
            onChain: false,
            joinedAtMs: now,
            lastSeenMs: now,
          },
        ];
        record.room = { ...room, seatCount: room.seatCount + 1 };
        return { ok: true };
      }
      case "release-seat": {
        if (seatAt === -1) return { ok: true };
        record.seats = seats.filter((_seat, index) => index !== seatAt);
        record.room = { ...room, seatCount: Math.max(0, room.seatCount - 1) };
        return { ok: true };
      }
      case "set-ready":
        return patchSeat({ ready: write.ready === true });
      case "set-display-name":
        return patchSeat({ displayName: cleanName(write.displayName, MAX_DISPLAY_NAME_LENGTH) });
      case "mark-on-chain":
        return patchSeat({ onChain: true });
      case "heartbeat":
        return patchSeat({});
      case "set-status": {
        const status = write.status;
        if (status !== "staging" && status !== "launching" && status !== "live" && status !== "closed") {
          return { ok: false, reason: "That is not a room status." };
        }
        record.room = { ...room, status, launchError: typeof write.launchError === "string" ? write.launchError : null };
        return { ok: true };
      }
      case "bind-chain-game-id": {
        if (!Number.isSafeInteger(write.chainGameId) || write.chainGameId < 0) {
          return { ok: false, reason: `Refusing to bind a non-integer on-chain game id: ${write.chainGameId}` };
        }
        /* WRITE-ONCE, as `firestore.rules` used to enforce: the one field other clients act on unverified. */
        if (room.chainGameId !== null && room.chainGameId !== write.chainGameId) {
          return { ok: false, reason: "That room is already bound to an on-chain game." };
        }
        record.room = { ...room, chainGameId: write.chainGameId, status: "live", launchError: null };
        return { ok: true };
      }
      default:
        return { ok: false, reason: "That is not a lobby write." };
    }
  };

  /* ==================================================================
      LIVE-3 §4: THE SUBMIT PIPELINE, AS ONE TASK ON THE ROOM'S ACTOR
     ==================================================================
     The frame has been parsed and shape-checked and the connection's identity is known (steps 0-1, in the
     socket's #1216 chain). From here every step reads the COMMITTED view and a private session that equals it:
       3a  a game held for an unknown store outcome takes no move (E-10)
       4-12 `RoomSession.submit`, unchanged: build, held room, ahead / anchor (new), deal pin, duplicate, stale,
           repair, authority, reducer and derived entries -- all SPECULATIVE on the private session
       13  the durable commit of everything the submit appended, as one batch -- the point of no return (E-13)
       15-17 publish: the committed view replaced, the submitter answered, the room fanned out, in one
           synchronous step, so fan-out order is commit order (LIVE-3 F-6) and nobody reads a move before the
           disk has it (F-1, F-3)
     A later submit can never build on an earlier one whose append is still pending: it does not start until
     that one has published or rolled back (E-1, LIVE-1's failure). */
  const submitOnActor = async (
    tx: Tx,
    game: GameActor,
    attached: Attached,
    frame: SubmitFrame,
    inReplyTo: string | undefined,
  ): Promise<void> => {
    const answer = (message: object) => tx.reply(answering(message, inReplyTo));
    if (tx.view.hold?.reason === "uncertain") {
      answer({ kind: "refused", code: "unavailable", reason: UNAVAILABLE_REASON, build: options.build });
      return;
    }
    /* LIVE-3B (§8.5, §17 class 5): a log held `corrupt` takes no move until an operator repairs it offline. */
    if (tx.view.hold?.reason === "corrupt") {
      answer({ kind: "refused", code: "held", reason: HELD_REASON, build: options.build });
      return;
    }
    /* ==================================================================
        LIVE-2A (LIVE-2 §12.2): THE LOG HAS A LENGTH, AND UNDO HAS A BUDGET
       ==================================================================
       Both are read off the COMMITTED view, before anything is speculated, and a refusal for either appends
       nothing, consumes no nonce and moves no `baseIndex` -- the two properties §12.2 requires of every rate
       refusal. The cap is 10,000 entries (an alarm at 5,000); the budget is 30 reverts of the seat's own action
       and 10 of another seat's (the host's reach) per hour, so patient undo churn can neither walk a game back
       unobserved nor grow its log without bound. */
    const length = tx.view.entries.length;
    if (length >= limits.logEntryAlarm && !logAlarmed.has(attached.room)) {
      logAlarmed.add(attached.room);
      // eslint-disable-next-line no-console
      console.warn(`  ingress: ${attached.room}'s log has reached ${length} entries (alarm at ${limits.logEntryAlarm}, cap ${limits.logEntryCap})`);
    }
    if (length >= limits.logEntryCap) {
      ingress.logFull += 1;
      answer({ kind: "refused", code: "log-full", reason: LOG_FULL_REASON, build: options.build });
      return;
    }
    let revertBudget: HourlyBudget | null = null;
    if ("RevertTo" in frame.msg) {
      const index = frame.msg.RevertTo.index;
      const target = effectiveActions(tx.view.entries).find((entry) => entry.index === index);
      /* The budget a revert spends is the reach it uses: its own seat's action, or (the host's) another's. A target
         that does not exist spends the seat's own -- and is then refused by the authority, spending nothing. */
      revertBudget = revertBudgetFor(attached.room, attached.actor, !target || target.actor === attached.actor ? "self" : "others");
      const wait = revertBudget.retryAfter();
      if (wait > 0) {
        ingress.revertBudgetRefused += 1;
        answer({ kind: "refused", code: RATE_LIMITED_CODE, reason: REVERT_BUDGET_REASON, retryAfterMs: wait, build: options.build });
        return;
      }
    }

    const session = tx.session;
    const before = session.entries.length;

    /* THE ACTOR COMES FROM THE CONNECTION, NEVER FROM THE FRAME (#1207). This line is the whole of the
       security posture; a `frame.actor` here would undo `turnAuthority` entirely. */
    /* ==================================================================
        DESIGN NOTE 1241: A THROWN SUBMIT IS ANSWERED, NOT SWALLOWED
       ==================================================================
       REPORTED: with Auto-Buy armed, every turn began with "Sending your last action — one moment" and
       the controls stayed grey until the client's six-second backstop (#1173) gave up. A throw inside
       `session.submit` was never answered; now it is refused and the client's latch released at once.
       LIVE-3A (E-9, F-13): AND NOTHING IT TOUCHED SURVIVES. The entry is pushed BEFORE the reducer runs, so a
       reducer that threw used to leave its entry on the log, where the append below stored it and the fan-out
       broadcast it as `applied` -- to everyone but the submitter, who was told `refused`. The private session
       is now rolled back to the committed view before anything is written, and the refusal carries a
       reference to the line printed here instead of the exception's own text. */
    let result: ServerMessage;
    try {
      result = session.submit({
        actor: attached.actor,
        build: frame.build,
        msg: frame.msg,
        baseIndex: frame.baseIndex,
        baseId: frame.baseId,
        submissionId: frame.submissionId,
        /* #1249: the host, from the room document this process already keeps (#1215), so the
           messages that are the host's to send can be refused to everybody else. `null` for a room
           with no document -- the authority skips the host-only checks then rather than refusing
           everyone. LIVE-3A: the COMMITTED document -- inside this task the map holds exactly the view's. */
        host: roomDocs.get(attached.room)?.hostId ?? null,
      });
    } catch (error) {
      tx.rollback();
      counters.internal += 1;
      const ref = errorRef();
      const reason = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.log(
        `  threw: ${attached.actor} sent ${Object.keys(frame.msg)[0]} — ${reason} (ref ${ref}); rolled back, nothing recorded\n` +
          `    payload ${excerpt(frame.msg, limits.logExcerptBytes)}`,
      );
      answer({ kind: "refused", code: "internal", reason: MOVE_INTERNAL_REASON(ref), build: options.build });
      return;
    }

    /* ==================================================================
        DESIGN NOTE 1218: THE SERVER SAYS WHY, IN THE WINDOW THAT IS ALREADY OPEN
       ==================================================================
       A refusal, a build skew and a catch-up all reach the shell as "the action was not sent", and two
       of the three arrive with no explanation at all. THE SERVER KNOWS EXACTLY WHICH IT WAS and was
       throwing that away -- so diagnosing a stuck button meant opening DevTools, which is a different
       skill from playing a game and a poor thing to require of a playtester.
       ONLY THE NON-APPLIED ANSWERS ARE LOGGED. An applied move is the normal case and one line per
       action would bury the interesting ones. */
    if (result.kind !== "applied") {
      const code = (result as { code?: string }).code;
      if (code === "ahead") counters.submitAhead += 1;
      if (code === "resync") counters.submitResync += 1;
      const why =
        (result as { reason?: string }).reason ??
        (result.kind === "build-skew"
          ? `client ${(result as { clientBuild?: string }).clientBuild} vs server ${options.build}`
          : `client was at ${frame.baseIndex}, room is at ${session.nextIndex - 1}`);
      // eslint-disable-next-line no-console
      console.log(`  ${result.kind}${code ? ` (${code})` : ""}: ${attached.actor} sent ${Object.keys(frame.msg)[0]} — ${why}`);
      if (code === "ahead" || code === "resync") {
        /* LIVE-3 §5.2: A DURABILITY TRIPWIRE. Under durable-before-visible no client can hold an entry the
           store does not; on one process with one store, any of these means history was lost or forked. */
        // eslint-disable-next-line no-console
        console.warn(
          `  resync: ${attached.actor} in ${attached.room} claims index ${frame.baseIndex}; the room's durable ` +
            `history ends at ${(result as { watermark?: number }).watermark} -- counted as a durability alarm`,
        );
      }
    }

    /* Everything this submit appended -- a repair, the move, its derived burst -- is ONE batch (L3-4). Nothing
       appended (a refusal, a duplicate, a stale catch-up, `ahead`) is answered now, from the committed state. */
    const batch = session.entries.slice(before);
    if (batch.length === 0) {
      answer(result);
      return;
    }
    const settled = await tx.commitBatch(batch, (settled) => submitDelivery(settled, batch, result, inReplyTo));
    if (settled.kind !== "committed" || result.kind !== "applied") return;
    /* LIVE-2A: a revert that landed spends its budget. */
    revertBudget?.record();
    /* LIVE-2A (§13.4 step 1, §15 #23): THE SERVER MARKS THE ROOM PLAYING WHEN THE DEAL IS COMMITTED -- the client's
       `status` write is only an echo now. A separate task on the same actor (a task commits once, E-6), queued
       behind this one, so the document it writes is derived from a durable deal. */
    if ("SetupGame" in frame.msg) markPlayingAfterDeal(game, attached.room);
  };

  /** The room document's `status: "playing"`, derived from the committed deal, made durable before it is shown. */
  const markPlayingAfterDeal = (game: GameActor, room: string): void => {
    void game
      .run("room-op", async (tx) => {
        const doc = tx.view.roomDoc as SandboxRoomDoc | null;
        if (!doc || doc.status !== "waiting") return false;
        if (dealEntryOf(effectiveActions(tx.view.entries)) === null) return false;
        let taken = false;
        await tx.commitRoomDoc({ ...doc, status: "playing" }, (settled) => ({
          after: () => {
            if (settled.kind !== "committed") return;
            taken = true;
            broadcastRoomDoc(room);
          },
        }));
        return taken;
      })
      .then(async (outcome) => {
        if (outcome.kind === "ran" && outcome.value === true) await broadcastSandboxRooms();
      })
      .catch(() => undefined);
  };

  /** What a settled batch owes its submitter and the room. */
  const submitDelivery = (
    settled: BatchSettlement,
    batch: readonly ServerLogEntry[],
    result: ServerMessage,
    inReplyTo: string | undefined,
  ): { reply: object; fanout?: object } => {
    if (settled.kind === "absent") {
      /* §4.1: definitely not durable -- the store holds nothing past the committed history. Nothing happened,
         and the nonce was forgotten with the rolled-back entries, so a retry is judged afresh. */
      return {
        reply: answering({ kind: "refused", code: "retry", reason: RECORD_FAILED_REASON, build: options.build }, inReplyTo),
      };
    }
    if (settled.kind === "unresolved") {
      return {
        reply: answering({ kind: "refused", code: "unavailable", reason: UNAVAILABLE_REASON, build: options.build }, inReplyTo),
      };
    }
    const { view, entries } = settled;
    const fields = view.fields ? { fields: { ...view.fields } } : {};
    /* FAN-OUT CARRIES WHAT WAS APPENDED, not the answer the submitter got -- a refusal is that client's
       business, and a catch-up is about how far behind IT was.
       #1223: THE WATCHERS' DIGEST IS COMPUTED, NOT BORROWED -- a refusal that carried repairs has no digest of
       its own, and an empty digest is "no verdict" (#232). The committed view's is the board as published.
       #1225: and the per-field digests with it, when the server explains itself. */
    const fanout = { kind: "applied", entries, digest: view.digest, ...fields, build: options.build };
    if (entries === batch) return { reply: answering(result, inReplyTo), fanout };
    /* THE STORE WAS READ BACK -- after a failed append, or a next view that could not be built (E-13) -- and
       what it holds is what stands. The submitter is told by whether its own entry, the one non-derived entry
       of the batch, is among the entries that stand: applied if so, and if not, the entries that DID land as
       history with a `retry`, never a refusal of a move the store holds (F-13's shape, one layer down). */
    const own = batch.find((entry) => !entry.derived);
    const landed = own !== undefined && entries.some((entry) => entry.id === own.id);
    const reply = landed
      ? { kind: "applied", entries, digest: view.digest, ...fields, build: options.build }
      : {
          kind: "refused",
          code: "retry",
          reason: RECORD_FAILED_REASON,
          catchUp: { entries, digest: view.digest, ...fields },
          build: options.build,
        };
    return { reply: answering(reply, inReplyTo), fanout };
  };

  const http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("1830 game server\n");
  });

  /* ==================================================================
      LIVE-2A (LIVE-2 §11.3): THE FRAME IS BOUNDED BEFORE IT IS READ
     ==================================================================
     `maxPayload` 32 KiB: a larger frame is closed 1009 by `ws` itself and not a byte of it is parsed -- LIVE-1's
     probe committed a 3 MB field. `perMessageDeflate: false`: no compression is negotiated, so there is no
     deflate bomb to inflate. */
  const wss = new WebSocketServer({ server: http, maxPayload: limits.maxPayloadBytes, perMessageDeflate: false });

  /* LIVE-2A (§12.2): KEEPALIVE. A ping every 25 s; a socket that has not answered one in 60 s is half-open and is
     terminated, so it holds no subscription, no queue slot and no presence entry (LIVE-1 R-7). */
  const lastPong = new Map<WebSocket, number>();
  const keepalive = setInterval(() => {
    const now = Date.now();
    for (const client of wss.clients) {
      const heard = lastPong.get(client) ?? now;
      if (now - heard > limits.pongTimeoutMs) {
        ingress.keepaliveTerminated += 1;
        client.terminate();
        continue;
      }
      try {
        client.ping();
      } catch {
        /* a socket mid-close; its close handler cleans up */
      }
    }
  }, limits.pingIntervalMs);
  keepalive.unref?.();

  /** Which bucket each frame kind draws on (LIVE-2 §12.2, per socket in LIVE-2A). */
  const BUCKET_FOR: Readonly<Record<string, BucketName>> = Object.freeze(
    Object.assign(Object.create(null) as Record<string, BucketName>, {
      submit: "submit",
      "chat-send": "chat",
      "presence-set": "presence",
      hello: "hello",
      "room-hello": "control",
      "lobby-hello": "control",
      "lobby-watch": "control",
      "room-write": "roomOps",
      "seat-pin": "roomOps",
      "claim-seat": "roomOps",
      "lobby-write": "roomOps",
    }),
  );

  wss.on("connection", (socket, request) => {
    /* ==================================================================
        DESIGN NOTE 1216: TWO FRAMES, ONE SOCKET, AND THE HANDLER THAT YIELDED
       ==================================================================
       REPORTED: "Clicking Host Game completely bypassed the waiting room and went straight to a game... At
       the bottom of the Auction tab screen there are no Players listed."

       THE ROOM WAS NEVER CREATED. The client opens its socket, sends `room-hello`, and immediately sends the
       queued `room-write` that hosts the room -- back to back, because nothing tells it to wait. The
       WebSocket delivers them in that order and this handler ran them in that order too, but the FIRST one
       AWAITS `resolveIdentity`. An `async` function that awaits yields the thread, so the second frame's
       handler started while the first was still suspended, found the socket not yet registered, and answered
       "say room-hello first". The write was dropped. The client then heard `{doc: null}`, `sandboxRoom` was
       null rather than "waiting", and the render fell straight through the waiting room into the game.

       SO FRAMES FROM ONE SOCKET ARE APPLIED IN THE ORDER THEY WERE SENT, by chaining each onto the last.
       `ws` delivers in order; it is the async handler that broke the guarantee, and awaiting a promise per
       socket restores it. Per socket rather than globally: one slow client must not stall the room.

       AND THE LOG PATH HAD THE SAME LATENT RACE -- `hello` also awaits `resolveIdentity`, and a client that
       submits before its catch-up arrives would have been told "say hello first". Nothing did that yet. The
       fix covers both because the queue is above the frame kinds, not inside one of them.

       THE SMOKE TEST IS WHY THIS REACHED A BROWSER, and that is the lesson worth keeping. It awaited the
       reply to `room-hello` before writing, so it was POLITE IN A WAY NO REAL CLIENT IS -- it tested a
       sequence the app never performs. `smokeTest.ts` now sends the pair back to back, exactly as the
       browser does. A harness that waits where the product does not is a harness that proves the wrong
       thing. */
    let inOrder: Promise<void> = Promise.resolve();

    /* LIVE-2A: this socket's own bounds -- its pending frames, its buckets, and its keepalive. */
    let pendingFrames = 0;
    const buckets = new SocketBuckets(limits, () => Date.now());
    lastPong.set(socket, Date.now());
    socket.on("pong", () => lastPong.set(socket, Date.now()));
    /* LIVE-2A: `ws` closes an oversize frame 1009 ITSELF and then reports it as an `error` on the socket -- which,
       with no listener, would throw out of the event loop and take the whole server down with one frame. Said in
       the window; the close that follows cleans up. */
    socket.on("error", (error) => {
      // eslint-disable-next-line no-console
      console.warn(`  ingress: socket error -- ${excerpt(error instanceof Error ? error.message : String(error), 200)}`);
    });

    /** A frame that is not one this server accepts: counted against the socket's malformed budget, logged as a
     *  bounded excerpt, and answered with a fixed sentence -- `refused` for a submit, so the shell's latch releases
     *  (#1449), `error` otherwise. */
    const badFrame = (raw: unknown, kind: string | null, reason: string, submissionId: string | undefined): void => {
      if (socket.readyState !== socket.OPEN) return; // closing already: nothing more is counted or answered
      ingress.badFrames += 1;
      // eslint-disable-next-line no-console
      console.log(`  bad-frame: ${reason} -- ${excerpt(String(raw), limits.logExcerptBytes)}`);
      if (buckets.take("malformed") > 0) {
        ingress.malformedClosed += 1;
        // eslint-disable-next-line no-console
        console.warn("  ingress: closed a socket for a malformed-frame flood -- 1008");
        socket.close(1008, "malformed frames");
        return;
      }
      if (kind === "submit") {
        send(socket, answering({ kind: "refused", code: BAD_FRAME_CODE, reason, build: options.build }, submissionId));
      } else {
        send(socket, { kind: "error", code: BAD_FRAME_CODE, reason });
      }
    };

    /** Over a bucket: answered in the frame each caller already listens for, never appended, never nonce-consuming. */
    const rateLimited = (frame: ClientFrame, bucket: BucketName, retryAfterMs: number): void => {
      if (socket.readyState !== socket.OPEN) return; // closing already: nothing more is counted or answered
      ingress.rateLimited += 1;
      ingress.rateLimitedByBucket[bucket] = (ingress.rateLimitedByBucket[bucket] ?? 0) + 1;
      buckets.consecutiveLimited += 1;
      if (buckets.consecutiveLimited >= limits.maxConsecutiveRateLimited) {
        ingress.rateLimitClosed += 1;
        // eslint-disable-next-line no-console
        console.warn(`  ingress: closed a socket after ${buckets.consecutiveLimited} consecutive rate-limited frames -- 4429`);
        socket.close(4429, "rate limited");
        return;
      }
      switch (frame.kind) {
        case "submit":
          send(
            socket,
            answering(
              { kind: "refused", code: RATE_LIMITED_CODE, reason: SUBMIT_RATE_LIMITED_REASON, retryAfterMs, build: options.build },
              submissionIdOf(frame),
            ),
          );
          return;
        case "presence-set":
          return; // a hint over its rate is dropped; the next one supersedes it anyway
        case "room-write": {
          const room = roomDocSockets.get(socket);
          send(socket, { kind: "error", reason: RATE_LIMITED_REASON, code: ROOM_WRITE_REFUSED_CODE, retryAfterMs } as never);
          if (room !== undefined) send(socket, { kind: "room", room, doc: publicDoc(roomDocs.get(room) ?? null) } as never);
          return;
        }
        case "seat-pin":
        case "claim-seat":
          send(socket, { kind: "seat", requestId: frame.requestId, ok: false, reason: RATE_LIMITED_REASON } as never);
          return;
        case "lobby-write":
          send(socket, { kind: "lobby-ack", requestId: frame.requestId, ok: false, reason: RATE_LIMITED_REASON } as never);
          return;
        default:
          send(socket, { kind: "error", code: RATE_LIMITED_CODE, reason: RATE_LIMITED_REASON, retryAfterMs });
      }
    };

    const handleFrame = async (raw: unknown): Promise<void> => {
      /* ==================================================================
          DESIGN NOTE 1449: THE PARSE IS NOT THE CHECK
         ==================================================================
         `JSON.parse` answers "was that JSON", and the `as` answered nothing at all -- a cast is a promise
         to the compiler that the wire never made. What followed was twelve `if (frame.kind === ...)`
         tests, so a frame that was a number, an array, or an object with no `kind` fell through all
         twelve and was dropped in silence: no answer to the client, no line in the window.
         TWO CHECKS, AT DIFFERENT DEPTHS. This one is thin on purpose -- "is this addressed to something
         that exists" -- because the lobby, chat and roster frames never reach the reducer or the log. The
         gameplay frame gets the real one, at the `submit` branch below, where a malformed message would
         otherwise become a permanent log entry. */
      /* ==================================================================
          LIVE-2A (LIVE-2 §11.1-§11.4): CLOSED FRAMES, FIXED ANSWERS, A BUDGET FOR MALFORMED ONES
         ==================================================================
         Every control frame now has a CLOSED schema (`parseClientFrame`): an unknown field, a field of the wrong
         shape, an overlong one, or a `__proto__` / `constructor` / `prototype` key anywhere is `bad-frame` -- with a
         fixed sentence that never echoes the frame's own kind, keys or text. Ten malformed frames a minute close the
         socket 1008. Then each kind draws on its bucket (§12.2); twenty consecutive `rate-limited` answers close
         it 4429. Only then is anything about the frame believed. */
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        badFrame(raw, null, "That frame is not JSON.", undefined);
        return;
      }
      const checked = parseClientFrame(parsed);
      if (!checked.ok) {
        badFrame(raw, checked.kind, checked.reason, submissionIdOf(parsed));
        return;
      }
      const frame = checked.frame as unknown as ClientFrame;
      const bucket = BUCKET_FOR[frame.kind];
      const wait = bucket === undefined ? 0 : buckets.take(bucket);
      if (wait > 0) {
        rateLimited(frame, bucket as BucketName, wait);
        return;
      }
      buckets.consecutiveLimited = 0;

      /* ---- THE WAITING ROOM (#1215) ----
         Answered before the log's frames and kept entirely separate from them. A socket that said
         `room-hello` is watching a roster and is not in `sockets`, so it never receives log fan-out and
         can never submit a move -- which is the property that keeps a lobby connection from being a way
         into the game. */
      if (frame.kind === "room-hello") {
        const actor = await options.resolveIdentity({
          claim: frame.claim,
          headers: request.headers as Record<string, string | string[] | undefined>,
        });
        if (!actor) {
          send(socket, { kind: "error", reason: "not authenticated" });
          socket.close();
          return;
        }
        const refused = await seatRefusal(frame.room, actor, frame.pin, frame.token);
        if (refused) {
          /* #1346: SAID IN THE WINDOW. A hello turned away silently looked, from the outside, like a wire
             that kept dropping -- the identity line printed on every attempt and nothing said why the
             socket closed a moment later. */
          // eslint-disable-next-line no-console
          console.warn(`  seat: refused room-hello from "${actor}" in ${frame.room} — ${refused.reason}`);
          send(socket, { kind: "error", ...refused } as never);
          socket.close();
          return;
        }
        roomDocSockets.set(socket, frame.room);
        roomDocActors.set(socket, actor);
        send(socket, {
          kind: "room",
          room: frame.room,
          doc: publicDoc(await roomDocFor(frame.room)),
        } as never);
        /* #1361a: the transcript and the current hints, so a joining or reconnecting tab is caught up on
           both without asking -- the same courtesy the document gets. */
        send(socket, { kind: "chat", room: frame.room, messages: await chatFor(frame.room) } as never);
        send(socket, presenceFrame(frame.room) as never);
        return;
      }

      /* ---- CHAT (#1361a) ---- stamped with the connection's identity and the server's clock. */
      if (frame.kind === "chat-send") {
        const actor = roomDocActors.get(socket);
        const room = roomDocSockets.get(socket);
        if (!actor || room !== frame.room) {
          send(socket, { kind: "error", reason: "say room-hello first" });
          return;
        }
        /* LIVE-2A (§11.2, §11.3): the single sanitizer, on the line and on the name it is signed with. The frame's
           500-character ceiling is its schema's (longer is `bad-frame`). */
        const text = sanitizeText(frame.text.trim(), MAX_CHAT_MESSAGE_LENGTH).trim();
        if (!text) return;
        const entry: RoomChatEntry = {
          id: `c${processTag}-${(chatMinted += 1)}`,
          author: actor,
          displayName: sanitizeName(frame.displayName, MAX_DISPLAY_NAME_LENGTH),
          text,
          at: Date.now(),
        };
        const transcript = [...(await chatFor(room)), entry].slice(-CHAT_HISTORY_LIMIT);
        roomChats.set(room, transcript);
        if (options.store?.appendChat) {
          try {
            await options.store.appendChat(room, entry);
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error(`  store: could not save a chat line for ${room}`, error);
          }
        }
        broadcastChat(room);
        return;
      }

      /* ---- PRESENCE (#1361a) ---- the sender's own seat, and only that. */
      if (frame.kind === "presence-set") {
        const actor = roomDocActors.get(socket);
        const room = roomDocSockets.get(socket);
        if (!actor || room !== frame.room) {
          send(socket, { kind: "error", reason: "say room-hello first" });
          return;
        }
        const seats = presence.get(room) ?? new Map<string, PresenceState>();
        if (frame.state && typeof frame.state === "object") {
          // #1397: the server's clock, not the sender's -- see `presenceFrame`.
          seats.set(actor, { ...(frame.state as PresenceState), playerId: actor, at: Date.now() });
        } else {
          seats.delete(actor);
        }
        presence.set(room, seats);
        broadcastPresence(room);
        return;
      }

      /* ---- THE STAGING LOBBY (#1361b) ---- on any socket; the list is public. PARKED (LIVE-0): see
         `STAGING_LOBBY_ENABLED` -- the hello still carries the public sandbox list, and nothing else. */
      if (frame.kind === "lobby-hello") {
        await lobbyReady;
        lobbySockets.add(socket);
        send(socket, { kind: "lobby", rooms: STAGING_LOBBY_ENABLED ? lobbyRooms() : [] } as never);
        /* #1415: and the list a table actually joins by. */
        send(socket, { kind: "rooms", rooms: await sandboxRooms() } as never);
        return;
      }
      if (frame.kind === "lobby-watch") {
        if (!STAGING_LOBBY_ENABLED) {
          lobbyWatch.delete(socket);
          if (typeof frame.roomId === "string" && frame.roomId) {
            send(socket, { kind: "lobby-room", roomId: frame.roomId, room: null, seats: [] } as never);
          }
          return;
        }
        await lobbyReady;
        if (typeof frame.roomId === "string" && frame.roomId) {
          lobbyWatch.set(socket, frame.roomId);
          const record = stagingRooms.get(frame.roomId) ?? null;
          send(socket, {
            kind: "lobby-room",
            roomId: frame.roomId,
            room: record?.room ?? null,
            seats: record?.seats ?? [],
          } as never);
        } else {
          lobbyWatch.delete(socket);
        }
        return;
      }
      if (frame.kind === "lobby-write") {
        const ask: LobbyWriteFrame = frame;
        if (!STAGING_LOBBY_ENABLED) {
          // eslint-disable-next-line no-console
          console.log("  lobby: refused a staging-lobby write -- the staging lobby is parked on this server (LIVE-0)");
          send(socket, { kind: "lobby-ack", requestId: ask.requestId, ok: false, reason: STAGING_LOBBY_PARKED_REASON } as never);
          return;
        }
        await lobbyReady;
        const write = ask.write;
        if (!write || typeof write !== "object" || typeof write.op !== "string") {
          send(socket, { kind: "lobby-ack", requestId: ask.requestId, ok: false, reason: "That is not a lobby write." } as never);
          return;
        }
        const outcome = applyLobbyWrite(write);
        if (outcome.ok) {
          await saveLobbyQuietly();
          broadcastLobby();
          const touched = write.op === "create-room" ? outcome.roomId : write.roomId;
          if (touched) broadcastLobbyRoom(touched);
        } else {
          // eslint-disable-next-line no-console
          console.log(`  lobby: refused ${write.op} — ${outcome.reason}`);
        }
        send(socket, { kind: "lobby-ack", requestId: ask.requestId, ...outcome } as never);
        return;
      }

      /* ---- THE SEAT PIN (#1341) ---- answered on the room-doc socket, to the asker alone.
         LIVE-3A: A TASK ON THE ROOM'S ACTOR, because a PIN is authority -- the hello gate reads it -- and it
         changes only after the store has the document (F-10). A save the store refused is answered as a failed
         claim with nothing changed; no token is minted and no socket is superseded for a PIN nobody holds. */
      if (frame.kind === "seat-pin" || frame.kind === "claim-seat") {
        const seatFrame: SeatPinFrame | ClaimSeatFrame = frame;
        const actor = roomDocActors.get(socket);
        const answer = (ok: boolean, reason?: string, token?: string) =>
          send(socket, { kind: "seat", requestId: seatFrame.requestId, ok, reason, token } as never);
        if (!actor || roomDocSockets.get(socket) !== frame.room) {
          answer(false, "say room-hello first");
          return;
        }
        let game: GameActor;
        try {
          game = await games.get(frame.room);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(`  store: could not load ${frame.room} for a seat request`, error);
          answer(false, LOAD_FAILED_REASON);
          return;
        }
        const outcome = await game.run(
          "room-op",
          async (tx) => {
            const doc = tx.view.roomDoc;
            if (!doc) {
              answer(false, "That room does not exist.");
              return;
            }
            if (!isValidSeatPin(frame.pin)) {
              answer(false, "A PIN is exactly four digits.");
              return;
            }
            const seat = doc.players.find((player) => player.id === seatFrame.playerId);
            if (!seat) {
              answer(false, "That seat is not in this room.");
              return;
            }
            const pins = doc.seatPins ?? {};

            if (frame.kind === "seat-pin") {
              if (seatFrame.playerId !== actor) {
                answer(false, "Only the seat's own player may set its PIN.");
                return;
              }
              const current = pins[actor];
              if (current && current !== frame.currentPin) {
                answer(false, "That is not this seat's current PIN.");
                return;
              }
              await tx.commitRoomDoc({ ...doc, seatPins: { ...pins, [actor]: frame.pin } }, (settled) => ({
                after: () => {
                  if (settled.kind !== "committed") {
                    answer(false, docRefusal(settled));
                    return;
                  }
                  /* The setter's own device holds the seat's first token, so its own log socket -- which said
                     hello without one -- stays valid: a hello carrying NO token is only refused once one exists,
                     and this device's next hello will carry this one. */
                  const token = tokenFor(frame.room, actor) ?? mintSeatToken();
                  setToken(frame.room, actor, token);
                  answer(true, undefined, token);
                  broadcastRoomDoc(frame.room); // `hasPin` changed for this seat
                },
              }));
              return;
            }

            // claim-seat
            const required = pins[seatFrame.playerId];

            /* ==================================================================
                DESIGN NOTE 1341a: A SEAT WITH NO PIN ADOPTS THE ONE IT IS OFFERED
               ==================================================================
               THE SEATS THAT EXIST ALREADY HAVE NO PIN. #1341 shipped into a live playtest whose seats were
               claimed before it existed, and the rule above -- "a seat without a PIN cannot be claimed" --
               locked exactly those players out of their own seats the moment they changed device. A rule that
               is right for every future room and wrong for every present one needs a migration, not an
               argument.

               SO THE FIRST PIN OFFERED FOR AN UNPINNED SEAT BECOMES ITS PIN, and from that moment the seat is
               an ordinary #1341 seat: the branch below demands this exact PIN of every later device, the gate
               demands it of every later hello, and the token supersedes whoever held it. One seat crosses over
               per claim, at the moment somebody needs it to, and no room has to be restarted to get there.

               WHAT THIS IS NOT: protection. An unPINned seat was ALREADY open to anybody who claimed its id --
               `seatRefusal` returns `null` when there is no PIN, so any hello naming that id was, and still
               is, believed (#1210). This branch does not open a door; it lets the person walking through it
               lock the door behind them. The cost it DOES carry is that the lock then works against the seat's
               own player too, so on a public URL the honest instruction is the one the playtest was given:
               set your PIN now, from the device you are already on, and the question stops being open.

               LOGGED LOUDLY for the same reason the insecure identity is: it is a thing the operator should be
               able to see happen in the window, not infer afterwards from a locked-out player. */
            /* The old device is told and closed; the new one adopts the id and reloads with the PIN and a fresh
               token in hand. The old device's reconnect then carries a stale token and is turned away. */
            const takeOver = () => {
              const token = mintSeatToken();
              setToken(seatFrame.room, seatFrame.playerId, token);
              for (const [other, attached] of sockets) {
                if (attached.room === seatFrame.room && attached.actor === seatFrame.playerId && other !== socket) {
                  send(other, {
                    kind: "error",
                    reason: "This seat was rejoined from another device.",
                    code: SEAT_SUPERSEDED_CODE,
                  } as never);
                  other.close();
                }
              }
              answer(true, undefined, token);
              /* #1341a: `hasPin` just changed for an adopting seat, and the roster is how every other screen
                 learns it. Harmless for a seat that already had one -- the document is identical. */
              broadcastRoomDoc(frame.room);
            };
            if (!required) {
              await tx.commitRoomDoc(
                {
                  ...doc,
                  seatPins: { ...pins, [seatFrame.playerId]: frame.pin },
                },
                (settled) => ({
                  after: () => {
                    if (settled.kind !== "committed") {
                      answer(false, docRefusal(settled));
                      return;
                    }
                    // eslint-disable-next-line no-console
                    console.warn(
                      `[#1341a] seat "${seat.nickname || seatFrame.playerId}" in ${frame.room} had no PIN and adopted ` +
                        `the one just offered. Every later device needs it. See design note 1341a.`,
                    );
                    takeOver();
                  },
                }),
              );
              return;
            } else if (required !== frame.pin) {
              answer(false, "Wrong PIN for that seat.");
              return;
            }
            takeOver();
          },
          { origin: originFor(socket, actor) },
        );
        if (outcome.kind === "busy") answer(false, BUSY_REASON);
        else if (outcome.kind === "expired") answer(false, EXPIRED_REASON);
        else if (outcome.kind === "failed") answer(false, ROOM_SAVE_FAILED_REASON);
        return;
      }

      /* ==================================================================
          LIVE-3A: A ROOM WRITE IS A TASK ON THE ROOM'S ACTOR, AND DURABLE BEFORE IT IS VISIBLE
         ==================================================================
         The document is authority today -- the host a submit is judged under (#1249), the seats a PIN guards --
         so it is serialized with the room's moves: a write queued behind a move sees that move's committed
         result, and a move queued behind a write is judged under the committed document (E-1, E-2).
         THE OLD ORDER WAS "change the map, then try the disk", and a failed save was logged and ignored, so a
         roster, a PIN or a host that every screen had been shown silently reverted at the next restart (LIVE-3
         F-10). Now the prospective document is saved first and published only if the store took it; a save
         the store refused is answered exactly as a refused write is -- `room-write-refused` and the unchanged
         document -- and the previous document stays authoritative. */
      if (frame.kind === "room-write") {
        /* ==================================================================
            LIVE-2A (LIVE-2 §13.4, §15 #2): THE WRITE GOES TO THE SOCKET'S OWN ROOM
           ==================================================================
           The room is the one this connection said `room-hello` for, read from this server's own state -- never
           `frame.room`, which used to select whichever room a frame named (LIVE-1: a socket watching X wrote Y). A
           frame naming another room is refused outright rather than silently redirected. */
        const room = roomDocSockets.get(socket);
        if (room === undefined) {
          send(socket, { kind: "error", reason: "say room-hello first" });
          return;
        }
        const refuse = (reason: string, doc: SandboxRoomDoc | null) => {
          /* #1415: told, not dropped -- and the current document re-sent, so a joiner whose optimistic
             "I am seated" the client may have painted is corrected by the roster that does not hold them. */
          send(socket, { kind: "error", reason, code: ROOM_WRITE_REFUSED_CODE } as never);
          send(socket, { kind: "room", room, doc: publicDoc(doc) } as never);
        };
        if (frame.room !== room) {
          // eslint-disable-next-line no-console
          console.warn(`  room-write: refused a write naming another room than the one this socket watches (${room})`);
          refuse("That change names a different room from the one you are in.", roomDocs.get(room) ?? null);
          return;
        }
        const actor = roomDocActors.get(socket);
        let game: GameActor;
        try {
          game = await games.get(room);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(`  store: could not load ${room} for a room write`, error);
          refuse(LOAD_FAILED_REASON, roomDocs.get(room) ?? null);
          return;
        }
        let taken = false;
        const outcome = await game.run(
          "room-op",
          async (tx) => {
            /* Dealt is the COMMITTED LOG's fact, not the document's `status` (which a client used to write). */
            const dealt = dealEntryOf(effectiveActions(tx.view.entries)) !== null;
            const result = applyRoomWrite(room, frame.write, actor, dealt);
            if (result.codeTaken) {
              /* The existing room is not re-sent: the writer asked to CREATE a room, and is told only to pick
                 another code (the client retries with a fresh one, `sandboxRoom.ts`). */
              send(socket, { kind: "error", reason: ROOM_CODE_TAKEN_REASON, code: ROOM_CODE_TAKEN_CODE } as never);
              return;
            }
            if (result.refused) {
              refuse(result.refused, result.doc);
              return;
            }
            if (result.echo) {
              send(socket, { kind: "room", room, doc: publicDoc(result.doc) } as never);
              return;
            }
            const { doc } = result;
            const committed = tx.view.roomDoc;
            /* Nothing to make durable -- a write to a room nobody hosted, or one that changed nothing: the
               committed document is re-sent as it stands, as it always was. */
            if (!doc || doc === committed) {
              taken = true;
              broadcastRoomDoc(room);
              return;
            }
            await tx.commitRoomDoc(doc, (settled) => ({
              after: () => {
                if (settled.kind !== "committed") {
                  refuse(docRefusal(settled), committed as SandboxRoomDoc | null);
                  return;
                }
                taken = true;
                broadcastRoomDoc(room);
              },
            }));
          },
          { origin: originFor(socket, actor ?? "") },
        );
        if (outcome.kind === "busy") refuse(BUSY_REASON, roomDocs.get(room) ?? null);
        else if (outcome.kind === "expired") refuse(EXPIRED_REASON, roomDocs.get(room) ?? null);
        else if (outcome.kind === "failed") refuse(ROOM_SAVE_FAILED_REASON, roomDocs.get(room) ?? null);
        /* #1415: the public list changed with this write -- a seat, a Ready, a status, a new room. Outside the
           actor: it reads committed documents only, and no game waits on it (E-3). */
        if (taken) await broadcastSandboxRooms();
        return;
      }

      if (frame.kind === "hello") {
        const actor = await options.resolveIdentity({
          claim: frame.claim,
          headers: request.headers as Record<string, string | string[] | undefined>,
        });
        if (!actor) {
          send(socket, { kind: "error", reason: "not authenticated" });
          socket.close();
          return;
        }
        const refused = await seatRefusal(frame.room, actor, frame.pin, frame.token);
        if (refused) {
          // eslint-disable-next-line no-console
          console.warn(`  seat: refused hello from "${actor}" in ${frame.room} — ${refused.reason}`);
          send(socket, { kind: "error", ...refused } as never);
          socket.close();
          return;
        }
        /* #1415: A PRIVATE GAME HAS NO SPECTATORS. The log socket is the game; once a private room is dealt
           it admits its own seats and nobody else -- the code is not a door to watching. Checked HERE and
           not on `room-hello`, because the roster socket is also how a new device claims a seat by PIN
           (#1341/#1355), and that device's id is not on the roster until the claim succeeds. */
        const privateDoc = await roomDocFor(frame.room);
        if (
          privateDoc &&
          privateDoc.status !== "waiting" &&
          roomVisibility(privateDoc) === "private" &&
          !privateDoc.players.some((player) => player.id === actor)
        ) {
          // eslint-disable-next-line no-console
          console.warn(`  seat: refused hello from "${actor}" in ${frame.room} — private game, not a seat`);
          send(socket, { kind: "error", reason: "This is a private game and cannot be watched.", code: SEAT_REFUSED_CODE } as never);
          socket.close();
          return;
        }
        sockets.set(socket, { room: frame.room, actor });
        let game: GameActor;
        try {
          game = await games.get(frame.room);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(`  store: could not load ${frame.room} for a hello`, error);
          send(socket, { kind: "error", code: "unavailable", reason: LOAD_FAILED_REASON });
          socket.close();
          return;
        }
        /* A JOINING CLIENT IS ALWAYS BEHIND, so the first thing it gets is everything it missed. `-1` for a
           client with nothing means "send me the game", which is the same path as a reconnect.
           ==================================================================
            LIVE-3A (§3.5): FROM HERE TO THE ANSWER IS ONE SYNCHRONOUS STEP
           ==================================================================
           The catch-up used to be read off the live session, so a hello that landed while a move awaited the
           disk was handed the move before the disk had it (LIVE-3 P1, F-3). `subscribe` registers this socket
           and answers it from the COMMITTED view with no await in between, and a publish is synchronous too:
           a socket registered before a publish receives its fan-out, one registered after sees it in this
           catch-up -- never neither, never both. The answer carries `inFlight`, this player's submissions still
           being committed, so a reconnecting tab does not call a move lost that is about to land (§4.2).
           A `baseIndex` above the room's durable watermark, or a `baseId` naming an entry the room does not
           hold there, is a history this room does not share: `resync`, and nothing registered (L3-3). */
        const fromIndex =
          Number.isInteger(frame.baseIndex) && (frame.baseIndex as number) >= -1 ? (frame.baseIndex as number) : -1;
        const baseId = typeof frame.baseId === "string" ? frame.baseId : undefined;
        unsubscribeLog(socket);
        const subscribed = game.subscribe(socket, subscriberFor(socket, actor), fromIndex, baseId);
        if (subscribed.kind === "subscribed") {
          logSubscriptions.set(socket, game);
          return;
        }
        if (subscribed.kind === "held") {
          send(socket, subscribed.frame);
          return;
        }
        counters.helloResync += 1;
        // eslint-disable-next-line no-console
        console.warn(
          `  resync: ${actor}'s hello in ${frame.room} holds index ${fromIndex}${baseId ? ` (${baseId})` : ""} but the ` +
            `room's durable history ends at ${subscribed.watermark} or holds another entry there -- counted as a ` +
            `durability alarm (LIVE-3 §5.2)`,
        );
        send(socket, { kind: "error", code: "resync", reason: subscribed.reason, watermark: subscribed.watermark });
        return;
      }

      if (frame.kind === "submit") {
        /* LIVE-3A (L3-3): EVERY DIRECT ANSWER NAMES THE SUBMISSION IT ANSWERS, the refusals before the actor
           included. The actor serializes a room, so another player's fan-out now reaches this socket before
           its own queued answer, and a client matching replies first-in-first-out took the other player's
           index for its own (LIVE-3 P4). */
        const inReplyTo = submissionIdOf(frame);
        const answer = (message: object) => send(socket, answering(message, inReplyTo));
        const attached = sockets.get(socket);
        if (!attached) {
          answer({ kind: "error", reason: "say hello first" });
          return;
        }
        /* ==================================================================
            DESIGN NOTE 1449: REFUSED BEFORE THE SESSION, NOT INSIDE IT
           ==================================================================
           MEASURED, not supposed: `{}`, `[]`, `{Nonsense:{}}`, `{BuyStock:{}}`, a `protocol_id` of
           `"x"` or `NaN`, a `percentage` of `Infinity`, a fractional hex and two discriminants in one
           object were every one of them answered `applied` and appended a permanent entry to the room's
           log. The reducer no-opped most of them, which is why nobody noticed: the BOARD was unchanged and
           the HISTORY was not, and `logHash` commits over the history.
           SO THE REFUSAL HAS TO LAND HERE, before the room's actor. Inside `RoomSession.submit` the append is
           the commit point (#1209) and the authority runs before it -- but the authority asks whose turn
           it is, which is a question about a message that has already been assumed to be one. A frame
           that is not a move must not reach a function whose job is deciding whose move it is.
           THE EXISTING TRANSPORT CARRIES IT. `refused` is what the shell already understands and already
           surfaces (#1218), so a malformed frame is answered the same way an illegal one is. */
        /* LIVE-2A (§11.1, §11.2): PARSE, DON'T VALIDATE. What reaches the actor is `parseGameplayMessage`'s NEW
           object, rebuilt from the declared fields alone -- nested waypoints, the deal's players, the variants,
           `token_cities` pairs -- so an undeclared field (or a megabyte of one) can never become part of the
           permanent, hashed log. `submissionId` is required and bounded. A malformed submit spends the socket's
           malformed budget like any other malformed frame, and its payload is logged as a bounded excerpt. */
        const envelope = validateSubmitEnvelope(frame);
        const shape = envelope.ok ? parseGameplayMessage(frame.msg) : envelope;
        if (!shape.ok) {
          badFrame(JSON.stringify(frame.msg) ?? "", "submit", shape.reason, inReplyTo);
          return;
        }
        if (!("value" in shape)) return; // the envelope's own verdict carries no message; unreachable when ok
        if (shape.stripped > 0) {
          ingress.stripped += shape.stripped;
          // eslint-disable-next-line no-console
          console.log(`  ingress: stripped ${shape.stripped} undeclared field(s) from a ${shape.kind} (LIVE-2 §11.2)`);
        }
        const parsedFrame: SubmitFrame = { ...frame, msg: shape.value as unknown as SandboxLogMsg };

        let game: GameActor;
        try {
          game = await games.get(attached.room);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(`  store: could not load ${attached.room} for a submit`, error);
          answer({ kind: "refused", code: "unavailable", reason: LOAD_FAILED_REASON, build: options.build });
          return;
        }
        /* LIVE-3 §4 STEPS 2-17 ARE ONE TASK ON THE ROOM'S ACTOR (`submitOnActor`). It starts only after every
           task queued before it has published or rolled back, and nothing it does is visible until the store
           has it. Awaited here, so this socket's frames stay in the order it sent them (#1216). */
        const outcome = await game.run("submit", (tx) => submitOnActor(tx, game, attached, parsedFrame, inReplyTo), {
          origin: originFor(socket, attached.actor, inReplyTo),
        });
        if (outcome.kind === "busy") {
          answer({ kind: "refused", code: "busy", reason: BUSY_REASON, build: options.build });
        } else if (outcome.kind === "expired") {
          // E-8: never ran, so nothing happened and the game is not held -- the client may simply act again.
          answer({ kind: "refused", code: "retry", reason: EXPIRED_REASON, build: options.build });
        } else if (outcome.kind === "failed") {
          // The task threw outside its own guard; the actor rolled it back (E-9). Said, with a reference.
          counters.internal += 1;
          const ref = errorRef();
          // eslint-disable-next-line no-console
          console.error(`  threw: a submit task for ${attached.room} failed (ref ${ref}); rolled back`, outcome.error);
          answer({ kind: "refused", code: "internal", reason: MOVE_INTERNAL_REASON(ref), build: options.build });
        }
        return;
      }
    };

    socket.on("message", (raw) => {
      /* LIVE-2A (§11.3): AT MOST 64 FRAMES IN FLIGHT PER SOCKET. The in-order chain below is a queue, and a queue
         a client can lengthen at will is memory a client can take; past the cap the socket is closed 1008. */
      if (pendingFrames >= limits.maxPendingFrames) {
        if (socket.readyState === socket.OPEN) {
          ingress.pendingOverflowClosed += 1;
          // eslint-disable-next-line no-console
          console.warn(`  ingress: closed a socket with ${pendingFrames} frames in flight -- 1008`);
          socket.close(1008, "too many frames in flight");
        }
        return;
      }
      pendingFrames += 1;
      inOrder = inOrder.then(async () => {
        try {
          await handleFrame(raw);
        } catch (error) {
          /* LIVE-2A (§11.5): EVERY HANDLER'S THROW IS ANSWERED WITH A REFERENCE, NEVER ITS TEXT. */
          ingress.internal += 1;
          const ref = errorRef();
          // eslint-disable-next-line no-console
          console.error(`  threw: a frame handler failed (ref ${ref})`, error);
          send(socket, { kind: "error", code: "internal", reason: INTERNAL_REASON(ref) });
        } finally {
          pendingFrames -= 1;
        }
      });
      /* A THROWN HANDLER MUST NOT POISON THE CHAIN. Without this, one bad frame would reject `inOrder` and
         every later frame on this socket would be skipped silently -- a socket that stops working with no
         error anywhere, which is the hardest kind of fault to find. */
      inOrder = inOrder.catch(() => undefined);
    });

    socket.on("close", () => {
      /* NOTHING IS ROLLED BACK ON A DISCONNECT, and #1209 is why: the append is the commit point and the
         response is only news. A player who vanishes mid-burst has still made their move, and the burst
         finishes itself on the next submission.
         LIVE-3A (E-8): A RUNNING TASK FINISHES -- its commit stands, and a reconnecting hello reports it in
         `inFlight` until it does. What this socket QUEUED and had not started is cancelled now, so it never
         runs after the player has gone and a reconnecting hello never reports it as pending. */
      lastPong.delete(socket);
      games.forEach((game) => game.cancelQueuedFrom(socket));
      unsubscribeLog(socket);
      sockets.delete(socket);
      /* #1215: the roster keeps the player. A closed tab is not a player leaving the table -- they refresh,
         they lose wifi, they come back -- and dropping them from the roster would empty a waiting room every
         time somebody reloaded. Rooms are in memory and die with the process, which is the only cleanup
         there is until `loadLog` and its equivalent for this record are wired. */
      /* #1361a: PRESENCE DOES NOT OUTLIVE THE SOCKET. A hint from a tab that is gone is a set of routes
         nobody is drafting; the client's staleness window would clear it in six seconds, and this clears it
         now. The transcript stays -- it is the room's, not the socket's. */
      const room = roomDocSockets.get(socket);
      const actor = roomDocActors.get(socket);
      if (room && actor && presence.get(room)?.delete(actor)) broadcastPresence(room);
      roomDocSockets.delete(socket);
      roomDocActors.delete(socket);
      lobbySockets.delete(socket);
      lobbyWatch.delete(socket);
    });
  });

  http.listen(options.port, GAME_SERVER_BIND_HOST);

  return {
    http,
    counters,
    ingress,
    limits,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(keepalive);
        games.close();
        for (const socket of sockets.keys()) socket.close();
        wss.close(() => http.close(() => resolve()));
      }),
  };
}
