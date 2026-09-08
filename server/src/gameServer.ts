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
import type { RoomDocWrite } from "../../frontend/src/utils/roomDocLink";
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
}

interface RoomWriteFrame {
  kind: "room-write";
  room: string;
  write: RoomDocWrite;
}

type ClientFrame = HelloFrame | SubmitFrame | RoomHelloFrame | RoomWriteFrame;

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
        next = {
          ...existing,
          players:
            at === -1
              ? [...existing.players, write.player]
              : existing.players.map((entry, index) => (index === at ? write.player : entry)),
        };
        break;
      }
      case "variants":
        /* #910: the whole object, never a field patch -- the variants are one agreement, and interleaved
           per-field writes would produce a config nobody at the table chose. */
        next = { ...existing, variants: write.variants };
        break;
      case "forced-sign":
        next = { ...existing, forcedSign: write.stage };
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
    const doc = roomDocs.get(code) ?? null;
    for (const [socket, watching] of roomDocSockets) {
      if (watching === code) send(socket, { kind: "room", room: code, doc } as never);
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
          roomDocSockets.set(socket, frame.room);
          send(socket, {
            kind: "room",
            room: frame.room,
            doc: await roomDocFor(frame.room),
          } as never);
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
      roomDocSockets.delete(socket);
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
