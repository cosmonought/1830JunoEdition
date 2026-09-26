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
  isRecognisedClientFrame,
  logHash,
  sandboxReplayProviders,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
  validateGameplayMessage,
  validateSubmitEnvelope,
  waterfallForRoster,
  withEmptyRoster,
} from "../../frontend/src/gameEngine";
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
import type { SandboxRoomDoc } from "../../frontend/src/utils/sandboxRoom";
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
/* LIVE-3A: every mutation of a game runs on that game's actor, and every read comes from its committed view. */
import {
  GameActor,
  UNAVAILABLE_REASON,
  newActorCounters,
  type ActorCounters,
  type BatchSettlement,
  type GameFaults,
  type GameStorePort,
  type Subscriber,
  type TaskOrigin,
  type Tx,
} from "./rooms/gameActor";
import { GameRegistry } from "./rooms/gameRegistry";

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

/* ==================================================================
    DESIGN NOTE 1355: A PIN FINDS ITS SEATS
   ==================================================================
   ASKED: "if players could just enter their PIN, they would have the option to click 'Rejoin' on the games
   they're currently in ... Does the PIN not already store the game and seat players chose?"
   IT DOES -- on the server, per room, per seat (`seatPins`). So the lobby asks the server, with the PIN
   alone and no room named, which seats carry it, and the server answers with every match across every room
   it holds: room code, seat, nickname, whether the game is waiting or playing. One match is a "Rejoin"
   button; several (two rooms, or two players who chose the same four digits in one room) are a short list to
   pick from by name. A PIN is not secret against a determined guesser -- four digits never are -- and this
   is a closed playtest; what it buys is one number to remember instead of three steps. Answered on any
   socket, before any hello, because the asker has no room yet. */
interface FindSeatsFrame {
  kind: "find-seats";
  requestId: string;
  pin: unknown;
}

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
  | FindSeatsFrame
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
     `fileLogStore.ts` in `start.ts`. `appendLog` is awaited between `session.submit` and the answer, so the
     `applied` frame and the fan-out both describe entries the disk has synced; a store that rejects rolls the
     session back (`discardAfter`) and the submitter is refused, because a move the disk does not hold did
     not happen (#1209, read literally). The room document is saved through the same store after every write
     and loaded with the log, so a restart restores a game whose roster still has names. */
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
/** E-9: a reference ties the sentence a player reads to the line in this window (LIVE-2 §11.5). */
const errorRef = (): string => Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, "0");

/** A direct answer to a submit names the submission it answers (L3-3); fan-out never does. */
const answering = <T extends object>(message: T, inReplyTo: string | undefined): T =>
  inReplyTo === undefined ? message : { ...message, inReplyTo };

export function createGameServer(options: GameServerOptions): {
  http: HttpServer;
  close: () => Promise<void>;
  /** LIVE-3A: the executor's counters (expiries, store failures, resyncs...), for tests and the smoke run. */
  counters: Readonly<ActorCounters & { submitAhead: number; submitResync: number; internal: number }>;
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

  const send = (socket: WebSocket, message: ServerFrame | object) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
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
  const storePort: GameStorePort = {
    loadLog: async (code) => (store ? await store.loadLog(code) : []),
    appendBatch: async (code, entries) => {
      if (store && entries.length > 0) await store.appendLog(code, entries);
    },
    loadRoomDoc: async (code) => (store ? await store.loadRoomDoc(code) : null),
    saveRoomDoc: async (code, doc) => {
      if (store) await store.saveRoomDoc(code, doc);
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
  type RoomWriteResult = { doc: SandboxRoomDoc | null; refused?: string };

  const applyRoomWrite = (code: string, write: RoomDocWrite, actor: string | undefined): RoomWriteResult => {
    const existing = roomDocs.get(code) ?? null;

    if (write.op === "host") {
      /* #527: every room opens in the anteroom with its host already seated, so the roster is never briefly
         empty in a room that plainly has somebody in it. */
      const variants = write.variants ?? STANDARD_VARIANTS;
      const created: SandboxRoomDoc = {
        code,
        hostId: write.hostId,
        status: "waiting",
        players: [{ id: write.hostId, nickname: write.nickname, isReady: false }],
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
        const at = existing.players.findIndex((entry) => entry.id === write.player.id);
        if (at === -1) {
          if (existing.kicked?.includes(write.player.id)) {
            return { doc: existing, refused: "The host removed you from this table." };
          }
          if (existing.status !== "waiting") {
            return { doc: existing, refused: "This game has already started." };
          }
          if (existing.players.length >= roomSeatCap(existing)) {
            return { doc: existing, refused: `This table is full (${roomSeatCap(existing)} seats).` };
          }
        }
        /* Design note #1337: A COLOUR ANOTHER SEAT HOLDS IS NOT TAKEN -- first write wins. The client greys
           out held swatches, but two clicks in flight at once both see a free swatch; the server is the one
           place both writes pass through, so the second keeps whatever colour it had before. */
        const wanted = write.player.color;
        const heldElsewhere =
          typeof wanted === "string" &&
          existing.players.some((entry, index) => index !== at && entry.color === wanted);
        const player = heldElsewhere
          ? (() => {
              const { color: _refused, ...rest } = write.player;
              const previous = at === -1 ? undefined : existing.players[at].color;
              return previous === undefined ? rest : { ...rest, color: previous };
            })()
          : write.player;
        next = {
          ...existing,
          players:
            at === -1
              ? [...existing.players, player]
              : existing.players.map((entry, index) => (index === at ? player : entry)),
        };
        break;
      }
      case "variants":
        /* #910: the whole object, never a field patch -- the variants are one agreement, and interleaved
           per-field writes would produce a config nobody at the table chose. */
        next = { ...existing, variants: write.variants };
        break;
      case "forced-sign":
        /* #1361b/#1404: VALIDATED, NOT CAST. Untrusted wire data; an unknown string would be a flag that
           matches no stage and never clears (the client's old Firestore reader checked the same three). */
        next = {
          ...existing,
          forcedSign:
            write.stage === "mark" || write.stage === "carcosa" || write.stage === "fog" ? write.stage : null,
        };
        break;
      case "status":
        next = { ...existing, status: write.status };
        break;
      case "kick": {
        if (!actor || actor !== existing.hostId) return { doc: existing, refused: "Only the host can remove a player." };
        if (existing.status !== "waiting") return { doc: existing, refused: "Players cannot be removed once the game has started." };
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
        return { doc: existing };
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
    attached: Attached,
    frame: SubmitFrame,
    inReplyTo: string | undefined,
  ): Promise<void> => {
    const answer = (message: object) => tx.reply(answering(message, inReplyTo));
    if (tx.view.hold?.reason === "uncertain") {
      answer({ kind: "refused", code: "unavailable", reason: UNAVAILABLE_REASON, build: options.build });
      return;
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
          `    payload ${JSON.stringify(frame.msg)}`,
      );
      answer({
        kind: "refused",
        code: "internal",
        reason: `The server could not process that move, so it was not made. (ref ${ref})`,
        build: options.build,
      });
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
    await tx.commitBatch(batch, (settled) => submitDelivery(settled, batch, result, inReplyTo));
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

  const wss = new WebSocketServer({ server: http });

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

    socket.on("message", (raw) => {
      inOrder = inOrder.then(async () => {
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
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          send(socket, { kind: "error", reason: "unparseable frame" });
          return;
        }
        if (!isRecognisedClientFrame(parsed)) {
          send(socket, { kind: "error", reason: "unrecognised frame" });
          return;
        }
        const frame = parsed as ClientFrame;

        /* ---- FIND MY SEATS BY PIN (#1355) ---- answered before any hello; the asker has no room yet. */
        if (frame.kind === "find-seats") {
          const ask: FindSeatsFrame = frame;
          const reply = (seats: Array<{ room: string; playerId: string; nickname: string; status: string }>, reason?: string) =>
            send(socket, { kind: "seats", requestId: ask.requestId, seats, reason } as never);
          if (!isValidSeatPin(frame.pin)) {
            reply([], "A PIN is exactly four digits.");
            return;
          }
          const codes = new Set<string>(roomDocs.keys());
          try {
            for (const code of (await options.store?.listRooms?.()) ?? []) codes.add(code);
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error("  store: could not list rooms for a PIN lookup", error);
          }
          const seats: Array<{ room: string; playerId: string; nickname: string; status: string }> = [];
          for (const code of codes) {
            const doc = await roomDocFor(code);
            if (!doc?.seatPins) continue;
            for (const player of doc.players) {
              if (doc.seatPins[player.id] === ask.pin) {
                seats.push({ room: code, playerId: player.id, nickname: player.nickname, status: doc.status });
              }
            }
          }
          reply(seats);
          return;
        }

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
          const text = typeof frame.text === "string" ? frame.text.trim().slice(0, MAX_CHAT_MESSAGE_LENGTH) : "";
          if (!text) return;
          const entry: RoomChatEntry = {
            id: `c${processTag}-${(chatMinted += 1)}`,
            author: actor,
            displayName: cleanName(frame.displayName, MAX_DISPLAY_NAME_LENGTH),
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
                      answer(false, ROOM_SAVE_FAILED_REASON);
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
                        answer(false, ROOM_SAVE_FAILED_REASON);
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
          if (!roomDocSockets.has(socket)) {
            send(socket, { kind: "error", reason: "say room-hello first" });
            return;
          }
          const refuse = (reason: string, doc: SandboxRoomDoc | null) => {
            /* #1415: told, not dropped -- and the current document re-sent, so a joiner whose optimistic
               "I am seated" the client may have painted is corrected by the roster that does not hold them. */
            send(socket, { kind: "error", reason, code: ROOM_WRITE_REFUSED_CODE } as never);
            send(socket, { kind: "room", room: frame.room, doc: publicDoc(doc) } as never);
          };
          let game: GameActor;
          try {
            game = await games.get(frame.room);
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error(`  store: could not load ${frame.room} for a room write`, error);
            refuse(LOAD_FAILED_REASON, roomDocs.get(frame.room) ?? null);
            return;
          }
          let taken = false;
          const outcome = await game.run(
            "room-op",
            async (tx) => {
              const { doc, refused } = applyRoomWrite(frame.room, frame.write, roomDocActors.get(socket));
              if (refused) {
                refuse(refused, doc);
                return;
              }
              const committed = tx.view.roomDoc;
              /* Nothing to make durable -- a write to a room nobody hosted, or one that changed nothing: the
                 committed document is re-sent as it stands, as it always was. */
              if (!doc || doc === committed) {
                taken = true;
                broadcastRoomDoc(frame.room);
                return;
              }
              await tx.commitRoomDoc(doc, (settled) => ({
                after: () => {
                  if (settled.kind !== "committed") {
                    refuse(ROOM_SAVE_FAILED_REASON, committed as SandboxRoomDoc | null);
                    return;
                  }
                  taken = true;
                  broadcastRoomDoc(frame.room);
                },
              }));
            },
            { origin: originFor(socket, roomDocActors.get(socket) ?? "") },
          );
          if (outcome.kind === "busy") refuse(BUSY_REASON, roomDocs.get(frame.room) ?? null);
          else if (outcome.kind === "expired") refuse(EXPIRED_REASON, roomDocs.get(frame.room) ?? null);
          else if (outcome.kind === "failed") refuse(ROOM_SAVE_FAILED_REASON, roomDocs.get(frame.room) ?? null);
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
          const inReplyTo = typeof frame.submissionId === "string" ? frame.submissionId : undefined;
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
          const envelope = validateSubmitEnvelope(frame);
          const shape = envelope.ok ? validateGameplayMessage(frame.msg) : envelope;
          if (!shape.ok) {
            // eslint-disable-next-line no-console
            console.log(
              `  malformed: ${attached.actor} sent a frame that is not a move — ${shape.reason}\n` +
                `    payload ${JSON.stringify(frame.msg)}`,
            );
            answer({ kind: "refused", reason: shape.reason, build: options.build });
            return;
          }

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
          const outcome = await game.run("submit", (tx) => submitOnActor(tx, attached, frame, inReplyTo), {
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
            answer({
              kind: "refused",
              code: "internal",
              reason: `The server could not process that move, so it was not made. (ref ${ref})`,
              build: options.build,
            });
          }
          return;
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
    close: () =>
      new Promise<void>((resolve) => {
        games.close();
        for (const socket of sockets.keys()) socket.close();
        wss.close(() => http.close(() => resolve()));
      }),
  };
}
