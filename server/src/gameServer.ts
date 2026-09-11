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
import { fieldDigests, stateDigest } from "../../frontend/src/utils/stateDigest";
import { sandboxReplayProviders } from "../../frontend/src/utils/replayProviders";
import type { ServerMessage } from "../../frontend/src/utils/serverProtocol";
import type { GameplayExecuteMsg } from "../../frontend/src/utils/sessionKey";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
} from "../../frontend/src/utils/sandboxState";
import { waterfallForRoster, withEmptyRoster } from "../../frontend/src/utils/gameSetup";
import { STANDARD_VARIANTS } from "../../frontend/src/utils/gameVariants";
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
import type { LogStore } from "./fileLogStore";
import { logHash } from "../../frontend/src/utils/logHash";

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
}

interface SubmitFrame {
  kind: "submit";
  build: string;
  msg: GameplayExecuteMsg;
  baseIndex: number;
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

/** #1361a: how much of a transcript a room keeps and sends. Mirrors `CHAT_HISTORY_LIMIT` in `ChatBox.tsx`. */
const CHAT_HISTORY_LIMIT = 200;
const MAX_CHAT_MESSAGE_LENGTH = 500;
const MAX_DISPLAY_NAME_LENGTH = 24;

const isValidSeatPin = (pin: unknown): pin is string => typeof pin === "string" && /^[0-9]{4}$/.test(pin);
const SEAT_SUPERSEDED_CODE = "seat-superseded";
/** #1346: a hello turned away for a seat reason -- a wrong or missing PIN. Terminal for the client: retrying
 *  the same hello cannot change the answer, so it must not loop. */
const SEAT_REFUSED_CODE = "seat-refused";
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
  onAppend?: (room: string, entries: readonly ServerLogEntry[]) => void;
}

interface Attached {
  room: string;
  actor: string;
}

export function createGameServer(options: GameServerOptions): {
  http: HttpServer;
  close: () => Promise<void>;
} {
  const rooms = new Map<string, RoomSession>();
  const sockets = new Map<WebSocket, Attached>();
  /** #1215. A separate map from `rooms` on purpose: this one holds no history and decides nothing. */
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

  /* #1250: the document is loaded with the room's log, once, and thereafter lives in the map as before. */
  const roomDocLoaded = new Set<string>();
  async function roomDocFor(code: string): Promise<SandboxRoomDoc | null> {
    if (!roomDocLoaded.has(code)) {
      roomDocLoaded.add(code);
      if (!roomDocs.has(code)) {
        const stored = await options.store?.loadRoomDoc(code);
        if (stored) roomDocs.set(code, stored);
      }
    }
    return roomDocs.get(code) ?? null;
  }

  async function roomFor(code: string): Promise<RoomSession> {
    const existing = rooms.get(code);
    if (existing) return existing;

    const session = new RoomSession({
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
    });

    /* RESTORED THROUGH `apply`, NEVER `submit` (#1203): a stored log already holds its derived entries. */
    const stored = (await options.store?.loadLog(code)) ?? [];
    if (stored.length > 0) {
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
    }
    await roomDocFor(code);

    rooms.set(code, session);
    return session;
  }

  const send = (socket: WebSocket, message: ServerMessage | { kind: "error"; reason: string }) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };

  /** Everyone in the room except the sender.
   *
   *  THE SAME MESSAGE THE SUBMITTER GOT, because it is the same news. A watcher applies the entries through
   *  its own engine exactly as the actor does -- which is what keeps every client's reducer live, and the
   *  divergence check with it (#1207). */
  const broadcast = (room: string, except: WebSocket, message: ServerMessage) => {
    for (const [socket, attached] of sockets) {
      if (socket !== except && attached.room === room) send(socket, message);
    }
  };

  /** #1215. Applies one named write and hands back the document, or `null` if the room does not exist yet
   *  and this write was not the one that creates it.
   *
   *  EVERY OP MIRRORS A FIRESTORE WRITER ONE FOR ONE, including the rule each carried. The upsert is the one
   *  with a rule worth restating: an existing player is replaced IN PLACE (#541), because `toSetupPlayers`
   *  reads this order to build the deal and a filter-and-append would move a player to the back of the table
   *  every time they typed a character of their name. */
  const applyRoomWrite = (code: string, write: RoomDocWrite): SandboxRoomDoc | null => {
    const existing = roomDocs.get(code) ?? null;

    if (write.op === "host") {
      /* #527: every room opens in the anteroom with its host already seated, so the roster is never briefly
         empty in a room that plainly has somebody in it. */
      const created: SandboxRoomDoc = {
        code,
        hostId: write.hostId,
        status: "waiting",
        players: [{ id: write.hostId, nickname: write.nickname, isReady: false }],
        variants: write.variants ?? STANDARD_VARIANTS,
        forcedSign: null,
      };
      roomDocs.set(code, created);
      return created;
    }

    /* A WRITE TO A ROOM NOBODY HOSTED IS DROPPED, not made to create one. A room whose `hostId` was invented
       from whoever wrote first would hand the Start button to an arbitrary player. */
    if (!existing) return null;

    let next: SandboxRoomDoc;
    switch (write.op) {
      case "upsert-player": {
        const at = existing.players.findIndex((entry) => entry.id === write.player.id);
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
      default:
        return existing;
    }

    roomDocs.set(code, next);
    return next;
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

  /** #1341: persist the room document after a seat write, the way `room-write` does. */
  const saveRoomDocQuietly = async (code: string) => {
    const doc = roomDocs.get(code);
    if (!doc || !options.store) return;
    try {
      await options.store.saveRoomDoc(code, doc);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`  store: could not save the room document for ${code}`, error);
    }
  };

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
        let frame: ClientFrame;
        try {
          frame = JSON.parse(String(raw)) as ClientFrame;
        } catch {
          send(socket, { kind: "error", reason: "unparseable frame" });
          return;
        }

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

        /* ---- THE STAGING LOBBY (#1361b) ---- on any socket; the list is public. */
        if (frame.kind === "lobby-hello") {
          await lobbyReady;
          lobbySockets.add(socket);
          send(socket, { kind: "lobby", rooms: lobbyRooms() } as never);
          return;
        }
        if (frame.kind === "lobby-watch") {
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
          await lobbyReady;
          const ask: LobbyWriteFrame = frame;
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

        /* ---- THE SEAT PIN (#1341) ---- answered on the room-doc socket, to the asker alone. */
        if (frame.kind === "seat-pin" || frame.kind === "claim-seat") {
          const seatFrame: SeatPinFrame | ClaimSeatFrame = frame;
          const actor = roomDocActors.get(socket);
          const answer = (ok: boolean, reason?: string, token?: string) =>
            send(socket, { kind: "seat", requestId: seatFrame.requestId, ok, reason, token } as never);
          if (!actor || roomDocSockets.get(socket) !== frame.room) {
            answer(false, "say room-hello first");
            return;
          }
          const doc = await roomDocFor(frame.room);
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
            roomDocs.set(frame.room, { ...doc, seatPins: { ...pins, [actor]: frame.pin } });
            await saveRoomDocQuietly(frame.room);
            /* The setter's own device holds the seat's first token, so its own log socket -- which said hello
               without one -- stays valid: a hello carrying NO token is only refused once one exists, and this
               device's next hello will carry this one. */
            const token = tokenFor(frame.room, actor) ?? mintSeatToken();
            setToken(frame.room, actor, token);
            answer(true, undefined, token);
            broadcastRoomDoc(frame.room); // `hasPin` changed for this seat
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
          if (!required) {
            roomDocs.set(frame.room, {
              ...doc,
              seatPins: { ...pins, [seatFrame.playerId]: frame.pin },
            });
            await saveRoomDocQuietly(frame.room);
            // eslint-disable-next-line no-console
            console.warn(
              `[#1341a] seat "${seat.nickname || seatFrame.playerId}" in ${frame.room} had no PIN and adopted ` +
                `the one just offered. Every later device needs it. See design note 1341a.`,
            );
          } else if (required !== frame.pin) {
            answer(false, "Wrong PIN for that seat.");
            return;
          }
          /* The old device is told and closed; the new one adopts the id and reloads with the PIN and a fresh
             token in hand. The old device's reconnect then carries a stale token and is turned away. */
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
          return;
        }

        if (frame.kind === "room-write") {
          if (!roomDocSockets.has(socket)) {
            send(socket, { kind: "error", reason: "say room-hello first" });
            return;
          }
          const doc = applyRoomWrite(frame.room, frame.write);
          /* #1250: saved before the fan-out, like the log. Last-write-wins, so a failed save is logged and
             the in-memory document stands -- the roster is not the game (#1215), and refusing a nickname
             because the disk hiccuped would be the wrong severity. */
          if (doc && options.store) {
            try {
              await options.store.saveRoomDoc(frame.room, doc);
            } catch (error) {
              // eslint-disable-next-line no-console
              console.error(`  store: could not save the room document for ${frame.room}`, error);
            }
          }
          broadcastRoomDoc(frame.room);
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
          sockets.set(socket, { room: frame.room, actor });
          const session = await roomFor(frame.room);
          /* A JOINING CLIENT IS ALWAYS BEHIND, so the first thing it gets is everything it missed. `-1` for a
             client with nothing means "send me the game", which is the same path as a reconnect. */
          send(socket, session.catchUp(frame.baseIndex ?? -1));
          return;
        }

        if (frame.kind === "submit") {
          const attached = sockets.get(socket);
          if (!attached) {
            send(socket, { kind: "error", reason: "say hello first" });
            return;
          }
          const session = await roomFor(attached.room);
          const before = session.entries.length;

          /* THE ACTOR COMES FROM THE CONNECTION, NEVER FROM THE FRAME (#1207). This line is the whole of the
             security posture; a `frame.actor` here would undo `turnAuthority` entirely. */
          /* ==================================================================
              DESIGN NOTE 1241: A THROWN SUBMIT IS ANSWERED, NOT SWALLOWED
             ==================================================================
             REPORTED: with Auto-Buy armed, every turn began with "Sending your last action — one moment" and
             the controls stayed grey until the client's six-second backstop (#1173) gave up. A refusal, a
             build skew or a catch-up would have released that latch at once AND printed here (#1218). Six
             seconds of nothing means the server never replied -- and the only path with no reply is an
             exception inside `session.submit`, which the chain guard below catches so one bad frame cannot
             poison the socket. Correct for the socket, silent for the fault: the reducer threw, nobody was
             told, and the shell had to time out to find out.
             SO A THROW BECOMES A REFUSAL WITH THE ERROR'S OWN SENTENCE, logged in the window that is already
             open and sent to the client whose move it was. The log is untouched -- the append is the commit
             point (#1209) and a throw before it appends nothing; a throw AFTER it would have appended an entry
             the engine could not apply, which is a divergence the digest will name on the next frame. */
          let result: ReturnType<typeof session.submit>;
          try {
            result = session.submit({
              actor: attached.actor,
              build: frame.build,
              msg: frame.msg,
              baseIndex: frame.baseIndex,
              submissionId: frame.submissionId,
              /* #1249: the host, from the room document this process already keeps (#1215), so the
                 messages that are the host's to send can be refused to everybody else. `null` for a room
                 with no document -- the authority skips the host-only checks then rather than refusing
                 everyone. */
              host: roomDocs.get(attached.room)?.hostId ?? null,
            });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            // eslint-disable-next-line no-console
            console.log(
              `  threw: ${attached.actor} sent ${Object.keys(frame.msg)[0]} — ${reason}\n` +
                `    payload ${JSON.stringify(frame.msg)}`,
            );
            result = { kind: "refused", reason: `The server could not apply that move: ${reason}`, build: options.build };
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
          /* #1250: THE DISK, BEFORE THE ANSWER. Everything this submit appended -- the move, its derived
             burst, any repair -- goes to the store and is synced before the submitter hears `applied` and
             before anybody else hears anything. A store that rejects rolls the session back to the length
             the disk last acknowledged and the submitter is refused: the move did not happen, and the log
             on disk, the board in memory and every client agree that it did not. */
          let appended = session.entries.slice(before);
          if (appended.length > 0 && options.store) {
            try {
              await options.store.appendLog(attached.room, appended);
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              // eslint-disable-next-line no-console
              console.error(
                `  store: could not append ${appended.length} entries for ${attached.room} — ${reason}; ` +
                  `rolled back to index ${before - 1}`,
              );
              session.discardAfter(before);
              appended = [];
              result = {
                kind: "refused",
                reason: "The server could not record that move, so it was not made. Try again.",
                build: options.build,
              };
            }
          }

          if (result.kind !== "applied") {
            const why =
              (result as { reason?: string }).reason ??
              (result.kind === "build-skew"
                ? `client ${(result as { clientBuild?: string }).clientBuild} vs server ${options.build}`
                : `client was at ${frame.baseIndex}, room is at ${session.nextIndex - 1}`);
            // eslint-disable-next-line no-console
            console.log(
              `  ${result.kind}: ${attached.actor} sent ${Object.keys(frame.msg)[0]} — ${why}`,
            );
          }

          send(socket, result);

          if (appended.length > 0) {
            options.onAppend?.(attached.room, appended);
            /* FAN-OUT CARRIES WHAT WAS APPENDED, not the answer the submitter got -- a refusal is that
               client's business, and a catch-up is about how far behind IT was. */
            broadcast(attached.room, socket, {
              kind: "applied",
              entries: appended,
              /* #1223: THE WATCHERS' DIGEST IS COMPUTED, NOT BORROWED. This read
                 `(result as { digest?: string }).digest ?? ""`, and the fallback is reachable -- a refusal
                 that still carried repairs appends entries and answers `refused`, which has no digest. Every
                 watcher then received `""`, and an empty digest is "no verdict" (#232), so the divergence
                 check would have been silently unavailable to exactly the clients that are not driving. The
                 board is right here; hashing it costs nothing and means something. */
              digest: stateDigest(session.state),
              /* #1225: a WATCHER needs these as much as the actor -- more, since a watcher's board is the one
                 nobody is looking at. Recomputed rather than borrowed, for #1223's reason. */
              ...(options.explainDivergence === true
                ? { fields: fieldDigests(session.state) }
                : {}),
              build: options.build,
            });
          }
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
         finishes itself on the next submission. */
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

  http.listen(options.port);

  return {
    http,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets.keys()) socket.close();
        wss.close(() => http.close(() => resolve()));
      }),
  };
}
