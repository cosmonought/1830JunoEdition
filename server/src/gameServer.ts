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

export interface GameServerOptions {
  port: number;
  build: string;
  resolveIdentity: ResolveIdentity;
  /** Where a room's history lives. In-memory by default; the store is a seam, not a decision made here. */
  loadLog?: (room: string) => Promise<readonly ServerLogEntry[]>;
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
  let minted = 0;

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
      mintId: () => `s${(minted += 1)}`,
      now: () => Date.now(),
    });

    /* RESTORED THROUGH `apply`, NEVER `submit` (#1203): a stored log already holds its derived entries. */
    const stored = (await options.loadLog?.(code)) ?? [];
    if (stored.length > 0) session.restore(stored);

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

  const http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("1830 game server\n");
  });

  const wss = new WebSocketServer({ server: http });

  wss.on("connection", (socket, request) => {
    socket.on("message", (raw) => {
      void (async () => {
        let frame: HelloFrame | SubmitFrame;
        try {
          frame = JSON.parse(String(raw)) as HelloFrame | SubmitFrame;
        } catch {
          send(socket, { kind: "error", reason: "unparseable frame" });
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
          const result = session.submit({
            actor: attached.actor,
            build: frame.build,
            msg: frame.msg,
            baseIndex: frame.baseIndex,
            submissionId: frame.submissionId,
          });

          send(socket, result);

          const appended = session.entries.slice(before);
          if (appended.length > 0) {
            options.onAppend?.(attached.room, appended);
            /* FAN-OUT CARRIES WHAT WAS APPENDED, not the answer the submitter got -- a refusal is that
               client's business, and a catch-up is about how far behind IT was. */
            broadcast(attached.room, socket, {
              kind: "applied",
              entries: appended,
              digest: (result as { digest?: string }).digest ?? "",
              build: options.build,
            });
          }
        }
      })();
    });

    socket.on("close", () => {
      /* NOTHING IS ROLLED BACK ON A DISCONNECT, and #1209 is why: the append is the commit point and the
         response is only news. A player who vanishes mid-burst has still made their move, and the burst
         finishes itself on the next submission. */
      sockets.delete(socket);
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
