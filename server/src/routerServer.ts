// server/src/routerServer.ts
//
// ==================================================================
//  LIVE-6 L6-1: A NON-PRIMARY TASK'S SERVER -- IT AUTHENTICATES, IT ANSWERS WHERE A GAME IS SERVED, AND IT CHANGES NOTHING
// ==================================================================
//
// A task of a pool that is not the primary (`SYSTEM/ROUTING`) holds its pool and nothing else: no identity-writer role,
// no relayer role, no ledger, no game claim, no money work, and no write of any durable game or identity state
// (`aws/runtime/awsRuntime.ts`). Before L6-1 it served nobody at all (the L5-7 standby: every upgrade refused). Now it
// serves what it can serve WITHOUT writing:
//
//   /gs/healthz  liveness, as every task;
//   /gs/readyz   its readiness as a NON-PRIMARY task (the runtime's answer: its pool held and freshly checked);
//   the socket   at `/gs` and its own pool's configured route path: every upgrade is decided by the SAME gate as the
//                primary's (`decideVerifiedUpgrade`: path, capacity, address, Origin, then the session cookie and the
//                profile answered by the IDENTITY VERIFIER's strongly consistent reads of the durable records, then the
//                socket caps -- checked again after the reads), and every frame's session is asked again from the
//                records at that frame's turn (revoked or expired: closed 4401, as the primary closes it);
//   `hello` / `room-hello` for a game: the game's record, read NOW, must let the principal read the game (an outsider
//                of a private game, an id with no game, or a record nobody can read gets what no game answers); then
//                -- for a protocol-1 socket whose frozen connection verdict is `ok` -- the game's owner from a strong
//                read of its HEAD (a released game: the primary, from a strong read of the routing), the destination
//                from the trusted route table, and LIVE-4's `route` frame, then close 4426 (`rooms/gameRoutes.ts`).
//                Anything that cannot be established -- no owner, an operator run, this pool itself, no destination,
//                a read that failed -- is answered `unavailable`, exactly as a game that cannot be served is answered
//                today; a legacy socket (no announcement) never gets a route frame and is answered that way too;
//   anything else  (the public list, a room operation, a move, chat, presence): answered `unavailable` in the frame the
//                client already listens for. Nothing is created, joined, claimed, loaded or written.
//
// THE CLIENT RULES ARE LIVE-4's, UNCHANGED: the announcement (`cp` / `cr` / `cb`) is parsed once at the upgrade by the
// canonical parser and judged once by the canonical connection verdict against this task's capability -- `reload` then
// 4426 for a protocol this pool does not accept or an announcement it cannot read, `legacy-refused` answered only in
// legacy frames. The per-game verdict (the tab's rules against the game's pin) is the serving pool's: this task reads no
// game history, and the pool a route names judges the tab at its own hello.
//
// THE TRANSPORT'S BOUNDS ARE THE GAME SERVER'S: the 32 KiB frame cap and no compression, the closed frame schema
// (`parseClientFrame`) and its malformed budget (1008), the per-kind buckets and the consecutive-refusal close (4429),
// the pending-frame cap (1008), the keepalive, and the unsubscribed reap -- which, since this server subscribes a socket
// to nothing, closes every socket 60 s after it opened.

import { createServer, type Server as HttpServer } from "http";
import { randomBytes } from "crypto";
import { WebSocketServer, type WebSocket } from "ws";

import { decideVerifiedUpgrade, refuseUpgrade, type ConnectionContext } from "./identity/authenticateUpgrade";
import { HEALTH_PATH } from "./identity/httpApi";
import { IdentityLimiter } from "./identity/limiter";
import type { SessionVerifier } from "./identity/verifier";
import { handleReadiness, type ReadinessAnswer } from "./ingress/readiness";
import { excerpt, resolveLimits, SocketBuckets, type BucketName, type IngressLimitOverrides } from "./ingress/limits";
import { isStoreCorrupt, isStoreIncompatible } from "./persistence/storeResult";
import { GAME_ID_PATTERN, type GameRecord } from "./rooms/gameRecord";
import { ownershipRouteFrame, routeOfGame, type GameDirectory, type PoolRoutes, type RouteLookup } from "./rooms/gameRoutes";
import { UNAVAILABLE_PLAYER_SENTENCE } from "./rooms/lifecycle";
import { authorize } from "./rooms/roomAuthz";
import { factsFromRecord } from "./rooms/roomHost";
import type { DeploymentCapability } from "../../frontend/src/gameEngine/compat/deploymentCapability";
import { clientVerdict, type ClientAnnouncement, type ClientVerdict } from "../../frontend/src/gameEngine/compat/clientCompatibility";
import { SUBMISSION_ID_PATTERN, parseClientFrame } from "../../frontend/src/gameEngine/messageSchema";
import { CLIENT_ANSWER_CLOSE_CODE, CLIENT_ANSWER_CLOSE_REASON, clientAnswerFor } from "../../frontend/src/utils/clientAnswers";

/** What a frame this server does not serve is told (it names nothing about any game). */
export const ROUTER_UNAVAILABLE_SENTENCE = "This game server is not serving tables right now. Reload the page to continue.";
/** The legacy wire's sentence when protocol 0 is no longer accepted (the game server's, word for word). */
const LEGACY_REFUSED_SENTENCE = "This page is out of date for this game server. Reload the page to continue.";
const PROFILE_REQUIRED_SENTENCE = "Log in or create an account to do that.";
const NOT_FOUND = { code: "not-found", reason: "There is no such game." } as const;

export interface RouterServerOptions {
  readonly port: number;
  readonly bindHost: string;
  readonly build: string;
  /** Production identity only (an AWS task): the allowed origins, the proxy hops, and the verifier. */
  readonly identity: {
    readonly allowedOrigins: readonly string[];
    readonly trustedProxyHops: number;
    readonly verifier: SessionVerifier;
    readonly now?: () => number;
  };
  /** This task's deployment capability: the connection-level client verdict is judged against it. */
  readonly capability: DeploymentCapability;
  /** The trusted route table (this pool is `routes.self`; its own path is answered). */
  readonly routes: PoolRoutes;
  /** The authoritative owner of a game, and the primary pool -- strong reads, nothing else. */
  readonly directory: GameDirectory;
  /** A game's record, read NOW (for the read authorization only). Read-only. */
  readonly records: { load(gameId: string): Promise<GameRecord | null> };
  readonly readiness: () => ReadinessAnswer;
  readonly limits?: IngressLimitOverrides;
  readonly log?: (line: string) => void;
  readonly warn?: (line: string) => void;
}

export interface RouterCounters {
  upgrades: number;
  refused: Record<string, number>;
  routed: number;
  unavailable: number;
  notFound: number;
  identityUnavailable: number;
  sessionClosed: number;
  reloads: number;
  legacyAnswered: number;
  badFrames: number;
}

export interface RouterServer {
  readonly http: HttpServer;
  readonly counters: Readonly<RouterCounters>;
  socketCount(): number;
  /** Close every socket (`code`: 1001 going away; 1012 when the task restarts into another role) and the HTTP server. */
  close(code?: number): Promise<void>;
}

const REF_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const errorRef = (): string => Array.from(randomBytes(6), (byte) => REF_ALPHABET[byte % 32]).join("");

const submissionIdOf = (frame: unknown): string | undefined => {
  const id = typeof frame === "object" && frame !== null ? (frame as { submissionId?: unknown }).submissionId : undefined;
  return typeof id === "string" && SUBMISSION_ID_PATTERN.test(id) ? id : undefined;
};

const BUCKET_FOR: Readonly<Record<string, BucketName>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, BucketName>, {
    submit: "submit",
    "chat-send": "chat",
    "presence-set": "presence",
    hello: "hello",
    "room-hello": "control",
    "room-op": "roomOps",
    "rooms-watch": "control",
  }),
);

export function createRouterServer(options: RouterServerOptions): RouterServer {
  const log = options.log ?? ((line: string) => console.log(line)); // eslint-disable-line no-console
  const warn = options.warn ?? ((line: string) => console.warn(line)); // eslint-disable-line no-console
  const now = options.identity.now ?? (() => Date.now());
  const limits = resolveLimits(options.limits);
  const allowedOriginList = [...options.identity.allowedOrigins];
  if (allowedOriginList.length === 0 || allowedOriginList.some((origin) => !origin.startsWith("https://"))) {
    throw new Error("createRouterServer: production identity needs https allowed origins");
  }
  const allowedOrigins: ReadonlySet<string> = new Set(allowedOriginList);
  const limiter = new IdentityLimiter(limits.identity, now);
  const counters: RouterCounters = { upgrades: 0, refused: {}, routed: 0, unavailable: 0, notFound: 0, identityUnavailable: 0, sessionClosed: 0, reloads: 0, legacyAnswered: 0, badFrames: 0 };

  /* The socket indexes the gate's caps count (in memory; they die with the process). */
  const contexts = new Map<WebSocket, ConnectionContext>();
  const clients = new Map<WebSocket, { readonly announcement: ClientAnnouncement; readonly connection: ClientVerdict }>();
  const bySession = new Map<string, Set<WebSocket>>();
  const byPrincipal = new Map<string, Set<WebSocket>>();
  const byIp = new Map<string, Set<WebSocket>>();
  const byAggregate = new Map<string, Set<WebSocket>>();
  const aggregateOf = new Map<WebSocket, string>();
  const add = (index: Map<string, Set<WebSocket>>, key: string, socket: WebSocket) => {
    let set = index.get(key);
    if (set === undefined) index.set(key, (set = new Set()));
    set.add(socket);
  };
  const remove = (index: Map<string, Set<WebSocket>>, key: string, socket: WebSocket) => {
    const set = index.get(key);
    if (set === undefined) return;
    set.delete(socket);
    if (set.size === 0) index.delete(key);
  };

  const send = (socket: WebSocket, frame: object) => {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > limits.maxOutboundBufferedBytes) {
      socket.close(1013, "slow consumer");
      return;
    }
    socket.send(JSON.stringify(frame));
  };
  const closeForSession = (socket: WebSocket, why: "expired" | "revoked") => {
    if (socket.readyState !== socket.OPEN && socket.readyState !== socket.CONNECTING) return;
    counters.sessionClosed += 1;
    socket.close(4401, why === "expired" ? "session expired" : "session ended");
  };
  /** Sockets whose link ended with a LIVE-4 answer (`reload` or `route`, then 4426): nothing they sent after is handled. */
  const answered = new WeakSet<WebSocket>();

  const http = createServer((request, response) => {
    if (handleReadiness(request, response, options.readiness)) return;
    let pathname = "/";
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      /* answered 503 below */
    }
    if (pathname === HEALTH_PATH && (request.method === "GET" || request.method === "HEAD")) {
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : "ok\n");
      return;
    }
    response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(request.method === "HEAD" ? undefined : "This game server is not serving tables.\n");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxPayloadBytes, perMessageDeflate: false });

  http.on("upgrade", (request, raw, head) => {
    raw.on("error", () => raw.destroy());
    void (async () => {
      let decision: Awaited<ReturnType<typeof decideVerifiedUpgrade>>;
      try {
        decision = await decideVerifiedUpgrade(request, {
          mode: "production",
          wsPath: "/gs",
          alsoWsPaths: options.routes.ownWsPaths,
          allowedOrigins,
          allowedOriginList,
          trustedProxyHops: options.identity.trustedProxyHops,
          verifier: options.identity.verifier,
          limiter,
          limits: limits.identity,
          counts: {
            global: () => contexts.size,
            forIp: (key) => byIp.get(key)?.size ?? 0,
            forAggregate: (aggregate) => byAggregate.get(aggregate)?.size ?? 0,
            forPrincipal: (principalId) => byPrincipal.get(principalId)?.size ?? 0,
            forSession: (sessionId) => bySession.get(sessionId)?.size ?? 0,
          },
          now,
        });
      } catch (error) {
        warn(`  router: the upgrade gate failed (ref ${errorRef()}) -- refused 503: ${error instanceof Error ? error.message : String(error)}`);
        refuseUpgrade(raw, 503, 5_000);
        return;
      }
      if (!decision.ok) {
        const key = `${decision.step}:${decision.status}`;
        counters.refused[key] = (counters.refused[key] ?? 0) + 1;
        if (decision.step === "authenticate" && decision.status === 503) counters.identityUnavailable += 1;
        refuseUpgrade(raw, decision.status, decision.retryAfterMs);
        return;
      }
      if (raw.destroyed) return; // the peer went away while the records were read
      const { ctx, ip, client } = decision;
      let connection: ClientVerdict;
      try {
        connection = clientVerdict(client, options.capability, null);
      } catch {
        connection = { kind: "legacy" };
      }
      /* SYNCHRONOUS from the gate's last cap check to the registration (the gate re-checked the caps after its reads). */
      wss.handleUpgrade(request, raw, head, (socket) => {
        counters.upgrades += 1;
        contexts.set(socket, ctx);
        clients.set(socket, { announcement: client, connection });
        add(bySession, ctx.sessionId, socket);
        add(byPrincipal, ctx.principalId, socket);
        add(byIp, ctx.ipKey, socket);
        if (ip.aggregate !== null) {
          aggregateOf.set(socket, ip.aggregate);
          add(byAggregate, ip.aggregate, socket);
        }
        wss.emit("connection", socket, request);
      });
    })();
  });

  /* The keepalive (LIVE-2A: a ping every 25 s; a socket silent for 60 s is terminated). */
  const lastPong = new Map<WebSocket, number>();
  const keepalive = setInterval(() => {
    const at = Date.now();
    for (const socket of wss.clients) {
      if (at - (lastPong.get(socket) ?? at) > limits.pongTimeoutMs) {
        socket.terminate();
        continue;
      }
      try {
        socket.ping();
      } catch {
        /* closing already */
      }
    }
  }, limits.pingIntervalMs);
  keepalive.unref?.();

  /** The route answer for `gameId` (see the header): authorization from the record, then the owner, then the frame. */
  const answerGame = async (socket: WebSocket, ctx: ConnectionContext, connection: ClientVerdict, gameId: string, op: "read-log" | "read-view"): Promise<void> => {
    let record: GameRecord | null = null;
    try {
      record = GAME_ID_PATTERN.test(gameId) ? await options.records.load(gameId) : null;
    } catch (error) {
      if (!isStoreCorrupt(error) && !isStoreIncompatible(error)) {
        counters.unavailable += 1;
        send(socket, { kind: "error", code: "unavailable", reason: UNAVAILABLE_PLAYER_SENTENCE });
        return;
      }
      /* A record nobody can read is answered as no game (nobody can be authorized against it). */
    }
    if (record === null) {
      counters.notFound += 1;
      send(socket, { kind: "error", ...NOT_FOUND });
      return;
    }
    const verdict = authorize(op, { record, facts: factsFromRecord(record), principalId: ctx.principalId, now: now(), held: false });
    if (!verdict.ok) {
      if (verdict.code === "not-found") counters.notFound += 1;
      send(socket, { kind: "error", code: verdict.code, reason: verdict.reason });
      return;
    }
    /* The legacy wire never sees a LIVE-4 frame: it is told what a game that cannot be served here tells it today. */
    if (connection.kind !== "ok") {
      counters.unavailable += 1;
      send(socket, { kind: "error", code: "unavailable", reason: UNAVAILABLE_PLAYER_SENTENCE });
      return;
    }
    const lookup: RouteLookup = await routeOfGame(gameId, options.directory, options.routes);
    const frame = lookup.kind === "route" ? ownershipRouteFrame(gameId, lookup.destination) : null;
    if (lookup.kind !== "route" || frame === null) {
      counters.unavailable += 1;
      log(`  router: ${gameId} has no destination (${lookup.kind === "none" ? lookup.why : "unsafe"}); answered unavailable`);
      send(socket, { kind: "error", code: "unavailable", reason: UNAVAILABLE_PLAYER_SENTENCE });
      return;
    }
    if (socket.readyState !== socket.OPEN) return;
    counters.routed += 1;
    log(`  router: ${gameId} is served by pool ${lookup.pool}: routed to ${frame.wsPath ?? frame.bundlePath}; closed ${CLIENT_ANSWER_CLOSE_CODE}`);
    answered.add(socket);
    send(socket, frame);
    socket.close(CLIENT_ANSWER_CLOSE_CODE, CLIENT_ANSWER_CLOSE_REASON);
  };

  /** What a frame this server does not serve is told, in the frame its client listens for. */
  const notServed = (socket: WebSocket, frame: { kind: string; requestId?: unknown }, sentence: string, code = "unavailable") => {
    switch (frame.kind) {
      case "room-op":
        send(socket, { kind: "room-ack", requestId: frame.requestId, ok: false, code, reason: sentence });
        return;
      case "submit":
        send(socket, { kind: "refused", code, reason: sentence, build: options.build, ...(submissionIdOf(frame) !== undefined ? { inReplyTo: submissionIdOf(frame) } : {}) });
        return;
      case "presence-set":
        return;
      default:
        send(socket, { kind: "error", code, reason: sentence });
    }
  };

  wss.on("connection", (socket: WebSocket) => {
    const ctx = contexts.get(socket) as ConnectionContext;
    const client = clients.get(socket) as { readonly announcement: ClientAnnouncement; readonly connection: ClientVerdict };
    /* LIVE-4 (L4-3): a protocol-1 client this pool cannot talk to is told so at once, and nothing it sends is handled. */
    const connectionAnswer = clientAnswerFor(client.connection);
    if (connectionAnswer.kind === "reload") {
      counters.reloads += 1;
      send(socket, connectionAnswer.frame);
      socket.close(CLIENT_ANSWER_CLOSE_CODE, CLIENT_ANSWER_CLOSE_REASON);
    }
    const reapTimer = setTimeout(() => {
      if (client.connection.kind === "legacy-refused") return; // a close would only make a legacy bundle reconnect
      if (socket.readyState === socket.OPEN) socket.close(1000, "no subscription");
    }, limits.rooms.unsubscribedReapMs);
    reapTimer.unref?.();
    lastPong.set(socket, Date.now());
    socket.on("pong", () => lastPong.set(socket, Date.now()));
    /* ws closes an oversize frame 1009 itself and reports it here: counted toward the address's malformed cooldown, as
       the game server counts it (LIVE-2 §11.4 item 3). */
    socket.on("error", (error) => {
      if ((error as { code?: unknown }).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" && limiter.cooldowns.record(ctx.ipKey)) {
        warn("  router: an address closed repeatedly for malformed frames -- its upgrades are refused for a while");
      }
    });
    const buckets = new SocketBuckets(limits, () => Date.now());
    let pending = 0;
    let inOrder: Promise<void> = Promise.resolve();

    const handleFrame = async (raw: unknown): Promise<void> => {
      if (client.connection.kind === "reload" || answered.has(socket) || socket.readyState !== socket.OPEN) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        parsed = undefined;
      }
      const checked = parsed === undefined ? null : parseClientFrame(parsed);
      if (checked === null || !checked.ok) {
        counters.badFrames += 1;
        if (buckets.take("malformed") > 0) {
          socket.close(1008, "malformed frames");
          if (limiter.cooldowns.record(ctx.ipKey)) warn("  router: an address closed repeatedly for malformed frames -- its upgrades are refused for a while");
          return;
        }
        const reason = checked === null ? "That frame is not JSON." : checked.reason;
        if ((checked?.kind ?? null) === "submit") send(socket, { kind: "refused", code: "bad-frame", reason, build: options.build, ...(submissionIdOf(parsed) !== undefined ? { inReplyTo: submissionIdOf(parsed) } : {}) });
        else send(socket, { kind: "error", code: "bad-frame", reason });
        return;
      }
      const frame = checked.frame as unknown as { kind: string; gameId?: unknown; requestId?: unknown };
      const bucket = BUCKET_FOR[frame.kind];
      const wait = bucket === undefined ? 0 : buckets.take(bucket);
      if (wait > 0) {
        buckets.consecutiveLimited += 1;
        if (buckets.consecutiveLimited >= limits.maxConsecutiveRateLimited) socket.close(4429, "rate limited");
        else notServed(socket, frame, "Too many requests too quickly. Wait a moment and try again.", "rate-limited");
        return;
      }
      buckets.consecutiveLimited = 0;

      /* The session, asked of the durable records at this frame's turn (the primary asks its writer's memory). */
      const verdict = await options.identity.verifier.recheck(ctx, now());
      if (verdict.kind === "expired" || verdict.kind === "revoked") {
        closeForSession(socket, verdict.kind);
        return;
      }
      if (verdict.kind === "unavailable") {
        counters.identityUnavailable += 1;
        warn(`  router: a socket's session could not be checked (${excerpt(verdict.detail, 200)}); the frame is answered unavailable`);
        notServed(socket, frame, ROUTER_UNAVAILABLE_SENTENCE);
        return;
      }
      /* LIVE-2E: DEFENCE IN DEPTH -- and P3-ACCT's signed-out allow-list (`gameServer.ts`): without a profile, only the
         public reads (a table's view or log, authorized per frame as for any watcher) are answered. */
      if (!verdict.profiled && frame.kind !== "hello" && frame.kind !== "room-hello") {
        notServed(socket, frame, PROFILE_REQUIRED_SENTENCE, "profile-required");
        return;
      }
      /* LIVE-4 (L4-3): protocol 0 retired on this pool -- answered only with frames a legacy bundle understands. */
      if (client.connection.kind === "legacy-refused") {
        counters.legacyAnswered += 1;
        if (frame.kind === "hello" || frame.kind === "submit") {
          send(socket, {
            kind: "incompatible",
            reason: LEGACY_REFUSED_SENTENCE,
            why: "client-protocol",
            pinnedRulesEngineVersion: null,
            supportedRulesEngineVersions: options.capability.rules.supported,
            build: options.build,
            ...(frame.kind === "submit" && submissionIdOf(frame) !== undefined ? { inReplyTo: submissionIdOf(frame) } : {}),
          });
        } else {
          notServed(socket, frame, LEGACY_REFUSED_SENTENCE);
        }
        return;
      }
      const gameId = typeof frame.gameId === "string" ? frame.gameId : null;
      if ((frame.kind === "hello" || frame.kind === "room-hello") && gameId !== null) {
        await answerGame(socket, ctx, client.connection, gameId, frame.kind === "hello" ? "read-log" : "read-view");
        return;
      }
      notServed(socket, frame, ROUTER_UNAVAILABLE_SENTENCE);
    };

    socket.on("message", (raw) => {
      if (pending >= limits.maxPendingFrames) {
        if (socket.readyState === socket.OPEN) socket.close(1008, "too many frames in flight");
        return;
      }
      pending += 1;
      inOrder = inOrder
        .then(async () => {
          try {
            await handleFrame(raw);
          } catch (error) {
            const ref = errorRef();
            warn(`  router: a frame handler failed (ref ${ref}) -- ${error instanceof Error ? error.message : String(error)}`);
            send(socket, { kind: "error", code: "internal", reason: `The server could not process that request. (ref ${ref})` });
          } finally {
            pending -= 1;
          }
        })
        .catch(() => undefined);
    });

    socket.on("close", () => {
      clearTimeout(reapTimer);
      lastPong.delete(socket);
      contexts.delete(socket);
      clients.delete(socket);
      remove(bySession, ctx.sessionId, socket);
      remove(byPrincipal, ctx.principalId, socket);
      remove(byIp, ctx.ipKey, socket);
      const aggregate = aggregateOf.get(socket);
      if (aggregate !== undefined) remove(byAggregate, aggregate, socket);
      aggregateOf.delete(socket);
    });
  });

  const prune = setInterval(() => limiter.prune(), limits.identity.sweepIntervalMs);
  prune.unref?.();

  http.listen(options.port, options.bindHost);

  return {
    http,
    counters,
    socketCount: () => contexts.size,
    close: (code = 1001) =>
      new Promise<void>((resolve) => {
        clearInterval(keepalive);
        clearInterval(prune);
        for (const socket of contexts.keys()) socket.close(code, code === 1012 ? "service restarting" : "server stopping");
        wss.close(() => http.close(() => resolve()));
      }),
  };
}
