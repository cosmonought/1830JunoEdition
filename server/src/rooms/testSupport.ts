// server/src/rooms/testSupport.ts
//
// LIVE-3A test support: a store the test controls, a raw socket client, and a probe session. Used by the
// `node --test` suites beside it (`npm test` in server/, after `npm run build`). Not imported by the server.
//
// LIVE-2D: every game is server-owned. There is no room document to seed and no `room`-keyed frame to send: a game is
// a GameRecord (`g_…`), reached by `gameId`, whose seats bind development principals (`pr_dev_<claim>`) to the log's
// actors (`player_id`). Two ways to get one: `openGame` walks the protocol a table walks (create, join by code, take
// a seat, ready, start-game), and `seedGame` writes the record straight into a record store -- for a game whose log
// is already on "disk" before the server starts (a restart, a stored history), exactly as the file adapter would find
// it.

import * as http from "http";
import { WebSocket } from "ws";

import { createGameServer, type GameServerIdentity, type GameServerOptions } from "../gameServer";
import { createDevAuthenticator, DEV_PRINCIPAL_PREFIX } from "../identity/devAuthenticator";
import type { IdentityLimits, RoomLimits } from "../ingress/limits";
import type { LogStore } from "../fileLogStore";
import { StoreDefiniteError } from "../persistence/storeResult";
import { RoomSession, type ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import type { SessionContinuation } from "../../../frontend/src/gameEngine/compat/sessionContinuation";
import {
  DEFAULT_SANDBOX_SCENARIO,
  sandboxReplayProviders,
  sandboxScenario,
  sandboxScenarioState,
  sandboxWaterfallState,
  waterfallForRoster,
  withEmptyRoster,
} from "../../../frontend/src/gameEngine";
import { resolveVariants } from "../../../frontend/src/gameEngine/gameVariants";
import { mintGameId, type GameRecord, type Seat } from "./gameRecord";
import type { RecordStore } from "./recordStore";
import { createRecord } from "./roomService";

export const BUILD = "live3a-build";
/** LIVE-2D: each of these is BOTH a development claim and the `player_id` of the seat that claim holds in a seeded
 *  game (`seedGame`), so the actor a log names is the socket that made it. A server-minted id is `p-` + 16 base32; the
 *  record accepts any `p-` id, which is what lets a stored log's actors be readable. */
export const ALICE = "p-alice";
export const BOB = "p-bob";
export const CAROL = "p-carol";
/** A deal in the reducer's shape. LIVE-2D: never sent by a client (the server deals at `start-game`, and a client's
 *  `SetupGame` is refused) -- it builds stored logs, and the refusal tests send it. */
export const SETUP = {
  SetupGame: {
    players: [
      { id: ALICE, nickname: "Alice" },
      { id: BOB, nickname: "Bob" },
    ],
    variants: {},
  },
};
/** The seat on turn buys the cheapest private: legal for Alice after the deal, then Bob, then Alice... */
export const BUY = { WaterfallBuyLowest: { game_id: 0 } };
export const PASS = { PassTurn: { game_id: 0 } };

/** The server says a great deal in its window; a test only needs it when something is being debugged. */
export function quietConsole(): void {
  if (process.env.LIVE3A_VERBOSE === "1") return;
  const silent = () => undefined;
  console.log = silent;
  console.warn = silent;
  console.error = silent;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function until(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(2);
  }
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface HeldAppend {
  room: string;
  entries: readonly ServerLogEntry[];
  release(): void;
  /** Reject the append. LIVE-3B: without `landed` it is a DEFINITE failure (nothing reached storage); with
   *  `landed` the entries are put in the store first and the rejection is UNCERTAIN (bytes reached the file, then an
   *  error the store could not settle by its redo). */
  fail(landed?: boolean): void;
}

/** An in-memory `LogStore` whose every call the test can hold, fail or slow. Its log only ever grows, exactly
 *  like a file: an entry that is in it has been "on disk" since it arrived. LIVE-2D: logs only -- a game's roster is
 *  its GameRecord, in the record store. */
export function controlledStore() {
  const logs = new Map<string, ServerLogEntry[]>();
  const calls = { loadLog: 0, appendLog: 0 };
  const control = {
    holdAppends: false,
    /** Immediate append failures, in order: `landed: false` is definite, `landed: true` uncertain (LIVE-3B). */
    failAppends: [] as Array<{ landed: boolean }>,
    failLoads: 0,
    loadDelayMs: 0,
  };
  const heldAppends: HeldAppend[] = [];
  const land = (room: string, entries: readonly ServerLogEntry[]) =>
    logs.set(room, [...(logs.get(room) ?? []), ...copy(entries)]);

  const store: LogStore = {
    async loadLog(room) {
      calls.loadLog += 1;
      if (control.loadDelayMs > 0) await sleep(control.loadDelayMs);
      if (control.failLoads > 0) {
        control.failLoads -= 1;
        throw new Error("injected read failure");
      }
      return copy(logs.get(room) ?? []);
    },
    appendLog(room, entries) {
      calls.appendLog += 1;
      if (control.holdAppends) {
        return new Promise<void>((resolve, reject) => {
          heldAppends.push({
            room,
            entries: copy(entries),
            release: () => {
              land(room, entries);
              resolve();
            },
            fail: (landed = false) => {
              if (landed) land(room, entries);
              reject(landed ? new Error("injected uncertain append failure") : new StoreDefiniteError("injected append failure"));
            },
          });
        });
      }
      const failure = control.failAppends.shift();
      if (failure) {
        if (failure.landed) land(room, entries);
        return Promise.reject(
          failure.landed ? new Error("injected uncertain append failure") : new StoreDefiniteError("injected append failure"),
        );
      }
      land(room, entries);
      return Promise.resolve();
    },
    /* LIVE-3C: discovery's peek at a log's deal (a store that cannot peek leaves every head unknown). */
    async listGameLogs() {
      return [...logs.keys()].filter((room) => (logs.get(room) ?? []).length > 0 && room.startsWith("g_"));
    },
    async readHead(room) {
      const stored = logs.get(room) ?? [];
      return stored.length === 0 ? { present: false, size: 0, first: null } : { present: true, size: JSON.stringify(stored).length, first: copy([stored[0]])[0] };
    },
  };

  return {
    store,
    logs,
    calls,
    control,
    heldAppends,
    log: (room: string): ServerLogEntry[] => logs.get(room) ?? [],
    indices: (room: string): number[] => (logs.get(room) ?? []).map((entry) => entry.index),
    async nextHeldAppend(): Promise<HeldAppend> {
      await until(() => heldAppends.length > 0, "a held append");
      return heldAppends.shift() as HeldAppend;
    },
  };
}

/* ==================================================================
    LIVE-2B: THE SUITES RUN UNDER THE DEVELOPMENT AUTHENTICATOR
   ==================================================================
   A socket says who it is with `?dev_claim=` on its URL, from a loopback Origin -- the only way development mode
   knows anybody -- and never in a frame. `devIdentity` builds the server's side exactly as `start.ts` does
   (`createDevAuthenticator` refuses unless GS_MODE is "development" at the call, so it is set around the call). */
export const DEV_ORIGIN = "http://localhost:3000";

export function devIdentity(over: Partial<GameServerIdentity> = {}): GameServerIdentity {
  const previous = process.env.GS_MODE;
  process.env.GS_MODE = "development";
  try {
    return { mode: "development", allowedOrigins: [DEV_ORIGIN], trustedProxyHops: 0, devAuthenticator: createDevAuthenticator(), ...over };
  } finally {
    if (previous === undefined) delete process.env.GS_MODE;
    else process.env.GS_MODE = previous;
  }
}

/** The development socket URL for `claim` on a test server. */
export const devSocketUrl = (port: number, claim: string): string => `ws://127.0.0.1:${port}/?dev_claim=${encodeURIComponent(claim)}`;

/** The principal the development authenticator gives `claim` -- what a seeded seat is bound to. */
export const devPrincipal = (claim: string): string => `${DEV_PRINCIPAL_PREFIX}${claim}`;

/** The LIVE-3A / LIVE-2A suites open sockets far faster than a table does, all from 127.0.0.1; they are not about
 *  the identity limits, so those are opened wide for them (the LIVE-2B suite sets its own). */
export const ROOMY_IDENTITY_LIMITS: Partial<IdentityLimits> = Object.freeze({
  failedUpgradesPerIp: { capacity: 1e6, refillPerSecond: 1e6 },
  upgradesPerIp: { capacity: 1e6, refillPerSecond: 1e6 },
  upgradesGlobal: { capacity: 1e6, refillPerSecond: 1e6 },
  maxSocketsPerPrincipal: 1_000,
  /* LIVE-2E: a development claim is one session, so a suite's many sockets for one claim meet this cap too. */
  maxSocketsPerSession: 1_000,
  maxSocketsPerIp: 10_000,
  /* LIVE-2E: every production browser a suite makes is a bootstrap and a profile creation from 127.0.0.1, and some
     redeem credentials; the suites that are about those budgets set them explicitly. */
  guestCreatesPerIp: { capacity: 1e6, refillPerSecond: 1e6 },
  profileCreatesPerIp: { capacity: 1e6, refillPerSecond: 1e6 },
  credentialRedeemsPerIp: { capacity: 1e6, refillPerSecond: 1e6 },
  profileActionsPerSession: { capacity: 1e6, refillPerSecond: 1e6 },
  credentialRedeemsPerSession: { capacity: 1e6, refillPerSecond: 1e6 },
});

/** LIVE-2D: every game is server-owned now, so every suite meets the room limits (creates, membership ops, the
 *  per-seat and per-game submit budgets). Suites that are not about them get them wide; the LIVE-2C suite sets its own
 *  and tests each one. */
export const ROOMY_ROOM_LIMITS: Partial<RoomLimits> = Object.freeze({
  createsPerPrincipal: { capacity: 1e6, refillPerSecond: 1e6 },
  createsPerIp: { capacity: 1e6, refillPerSecond: 1e6 },
  createsGlobal: { capacity: 1e6, refillPerSecond: 1e6 },
  membershipOpsPerPrincipal: { capacity: 1e6, refillPerSecond: 1e6 },
  submitsPerSeat: { capacity: 1e6, refillPerSecond: 1e6 },
  submitsPerGame: { capacity: 1e6, refillPerSecond: 1e6 },
});

/** The deal in seat order (host first), so a test knows who is on turn. Pass `shuffle: undefined` for the crypto one. */
export const IN_SEAT_ORDER = <T>(items: readonly T[]): T[] => [...items];

export async function startServer(over: Partial<GameServerOptions> = {}) {
  const server = createGameServer({
    port: 0,
    build: BUILD,
    identity: devIdentity(),
    shuffle: IN_SEAT_ORDER,
    ...over,
    limits: {
      ...(over.limits ?? {}),
      identity: { ...ROOMY_IDENTITY_LIMITS, ...(over.limits?.identity ?? {}) },
      rooms: { ...ROOMY_ROOM_LIMITS, ...(over.limits?.rooms ?? {}) },
    },
  });
  const port = await new Promise<number>((resolve) => {
    const read = () => {
      const address = server.http.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    };
    if (server.http.listening) read();
    else server.http.once("listening", read);
  });
  return { server, port };
}

export interface Frame {
  kind: string;
  [key: string]: unknown;
}

export interface SeenEntry {
  index: number;
  id: string;
  submission_id?: string;
  actor: string;
}

/** Every client a test opened and has not closed, so a failed assertion cannot leave a socket that keeps the
 *  server's `close()` waiting. */
const openClients = new Set<Client>();

/** Stop a server started by `startServer`, closing every client still open first. */
export async function stopServer(server: { close(): Promise<void> }): Promise<void> {
  for (const client of [...openClients]) client.socket.terminate();
  openClients.clear();
  await server.close();
}

let requests = 0;

/** A raw socket client: records every frame in order. LIVE-2D: it speaks only the server-owned protocol -- `hello`,
 *  `room-hello` and every room operation name a `gameId`. */
export class Client {
  readonly frames: Frame[] = [];
  private cursor = 0;
  /** The close code, once the socket closes (LIVE-2E: 4401 when its session ends). */
  readonly closed: Promise<number>;

  private constructor(
    readonly socket: WebSocket,
    readonly claim: string,
  ) {
    this.closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
  }

  static open(port: number, claim: string): Promise<Client> {
    return Client.connect(new WebSocket(devSocketUrl(port, claim), { origin: DEV_ORIGIN }), claim);
  }

  /** LIVE-2E: a PRODUCTION socket -- `/gs`, the browser's session cookie and an allowed Origin, exactly as a browser
   *  opens one. `label` only names the client in a timeout message. Rejects when the upgrade is refused. */
  static openWithCookie(port: number, cookie: string, label: string, origin: string = PROD_ORIGIN): Promise<Client> {
    return Client.connect(new WebSocket(`ws://127.0.0.1:${port}/gs`, { headers: { Cookie: cookie }, origin }), label);
  }

  private static connect(socket: WebSocket, claim: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new Client(socket, claim);
      openClients.add(client);
      socket.on("close", () => openClients.delete(client));
      socket.on("message", (raw) => client.frames.push(JSON.parse(String(raw)) as Frame));
      socket.once("error", reject);
      socket.once("open", () => resolve(client));
    });
  }

  send(frame: object): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** The log subscription of a server-owned game. */
  hello(gameId: string, baseIndex = -1, baseId?: string): void {
    this.send({ kind: "hello", gameId, build: BUILD, baseIndex, ...(baseId ? { baseId } : {}) });
  }

  /** `build`: the bundle's build this tab says it runs (LIVE-4 L4-2: a tab on the server's own build after a deploy). */
  submit(msg: object, over: { baseIndex: number; submissionId?: string; baseId?: string; build?: string }): void {
    this.send({ kind: "submit", build: BUILD, msg, ...over });
  }

  /** The room view (and chat and presence) of a server-owned game. */
  roomHello(gameId: string): void {
    this.send({ kind: "room-hello", gameId, build: BUILD });
  }

  /** Send one room operation; the answer is the `room-ack` naming the returned request id. */
  roomOp(body: Record<string, unknown>, gameId?: string): string {
    requests += 1;
    const requestId = `rq-${requests}`;
    this.send({ kind: "room-op", requestId, ...(gameId !== undefined ? { gameId } : {}), op: body });
    return requestId;
  }

  /** The `room-ack` for `requestId` (found anywhere in the frames; the cursor is not moved). */
  async ack(requestId: string): Promise<Frame> {
    const match = (frame: Frame) => frame.kind === "room-ack" && frame.requestId === requestId;
    await until(() => this.frames.some(match), `the ack ${requestId} for ${this.claim} (saw ${this.frames.map((f) => f.kind).join(",")})`);
    return this.frames.find(match) as Frame;
  }

  /** A room operation, answered. */
  op(body: Record<string, unknown>, gameId?: string): Promise<Frame> {
    return this.ack(this.roomOp(body, gameId));
  }

  /** The next frame after the cursor that matches, waiting for it if it has not arrived. */
  async next(predicate: (frame: Frame) => boolean = () => true, label = "a frame"): Promise<Frame> {
    const find = () => this.frames.findIndex((frame, at) => at >= this.cursor && predicate(frame));
    await until(() => find() !== -1, `${label} for ${this.claim} (saw ${this.frames.map((f) => f.kind).join(",")})`);
    const at = find();
    this.cursor = at + 1;
    return this.frames[at];
  }

  /** The direct answer to one submission. */
  answerTo(submissionId: string): Promise<Frame> {
    return this.next((frame) => frame.inReplyTo === submissionId, `the answer to ${submissionId}`);
  }

  of(kind: string): Frame[] {
    return this.frames.filter((frame) => frame.kind === kind);
  }

  /** Every entry this client has been handed, in arrival order, from every frame that carries entries. */
  seen(): SeenEntry[] {
    const out: SeenEntry[] = [];
    for (const frame of this.frames) {
      const batches: unknown[] = [];
      if (frame.kind === "applied" || frame.kind === "catch-up") batches.push(frame.entries);
      if (frame.kind === "refused" && frame.catchUp) batches.push((frame.catchUp as { entries: unknown }).entries);
      for (const batch of batches) for (const entry of (batch as SeenEntry[]) ?? []) out.push(entry);
    }
    return out;
  }

  get open(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }
}

/* ==================================================================
    LIVE-2D: OWNED GAMES FOR THE SUITES
   ================================================================== */

export interface OpenedGame {
  gameId: string;
  code: string;
  /** Each claim's seat. */
  playerIds: Record<string, string>;
  /** The claims, host first -- the deal's turn order under `IN_SEAT_ORDER`. */
  seats: string[];
}

/** A table walked through the protocol, as clients walk it: `host` creates, each guest joins by code and takes a
 *  seat, everyone marks ready, and -- unless `start: false` -- the host sends `start-game` and the SERVER deals. The
 *  sockets used are closed before it returns; a test opens its own log clients. */
export async function openGame(
  port: number,
  host: string,
  guests: readonly string[],
  over: { start?: boolean; visibility?: "public" | "private" } = {},
): Promise<OpenedGame> {
  const hostClient = await Client.open(port, host);
  const created = await hostClient.op({ type: "create", visibility: over.visibility ?? "public", exactPlayers: null, variants: {}, nickname: host });
  if (created.ok !== true) throw new Error(`create refused: ${JSON.stringify(created)}`);
  const { gameId, code, playerId } = created.data as { gameId: string; code: string; playerId: string };
  const playerIds: Record<string, string> = { [host]: playerId };
  const clients = [hostClient];
  for (const guest of guests) {
    const client = await Client.open(port, guest);
    clients.push(client);
    const joined = await client.op({ type: "join", code, takeSeat: true });
    if (joined.ok !== true) throw new Error(`join refused for ${guest}: ${JSON.stringify(joined)}`);
    playerIds[guest] = (joined.data as { playerId: string }).playerId;
  }
  for (const client of clients) {
    const ready = await client.op({ type: "set-ready", ready: true }, gameId);
    if (ready.ok !== true) throw new Error(`set-ready refused for ${client.claim}: ${JSON.stringify(ready)}`);
  }
  if (over.start !== false) {
    const started = await hostClient.op({ type: "start-game" }, gameId);
    if (started.ok !== true) throw new Error(`start-game refused: ${JSON.stringify(started)}`);
  }
  await Promise.all(clients.map((client) => client.close()));
  return { gameId, code, playerIds, seats: [host, ...guests] };
}

/** A GameRecord whose seats are bound to development claims, each seat's `player_id` the claim itself (ALICE, BOB...).
 *  The first claim holds the host seat. `dealt`: the record as it stands once its log holds a deal (active, started,
 *  the turn order cached -- nothing for a load to repair); otherwise waiting, every seat ready. */
export function seededRecord(claims: readonly string[] = [ALICE, BOB], over: { dealt?: boolean; gameId?: string; now?: number } = {}): GameRecord {
  const now = over.now ?? Date.now();
  const made = createRecord({
    gameId: over.gameId ?? mintGameId(),
    joinCode: "JUNO-AAAA-AAAA",
    principalId: devPrincipal(claims[0]),
    now,
    visibility: "public",
    exactPlayers: null,
    variants: resolveVariants({}),
    nickname: claims[0],
    color: null,
    hostPlayerId: claims[0],
  });
  if (!made.ok || made.record === null) throw new Error("seededRecord: createRecord refused");
  const record = made.record;
  const seat = (claim: string): Seat => ({
    player_id: claim,
    principal_id: devPrincipal(claim),
    binding_epoch: 0,
    joined_at: now,
    bound_at: now,
    ready: true,
    nickname: claim,
    color: null,
    payout_address: null,
    chain_seat_index: null,
  });
  /* The join code is dropped: a seeded game is reached by id, and no index entry exists for a code to resolve to. */
  const seeded: GameRecord = { ...record, join_code: null, seats: claims.map(seat) };
  if (over.dealt) {
    return { ...seeded, status: "active", started_at: now, expires_at: null, turn_order: [...claims] };
  }
  return seeded;
}

/** Put a seeded record in `records` (before the server starts, as a restart finds it) and answer its game id. */
export async function seedGame(records: RecordStore, claims: readonly string[] = [ALICE, BOB], over: { dealt?: boolean; gameId?: string } = {}): Promise<string> {
  const record = seededRecord(claims, over);
  const put = await records.put(record, null);
  if (put.kind !== "committed") throw new Error(`seedGame: the record store refused the seed (${JSON.stringify(put)})`);
  return record.game_id;
}

/* ==================================================================
    LIVE-2E: PRODUCTION BROWSERS -- A COOKIE, AND A PROFILE BEFORE ANY GAME SOCKET
   ==================================================================
   Profiles are mandatory: a production (cookie) principal opens no game socket until its browser has created, recovered
   or linked a profile -- the upgrade answers 403 (step "profile"). So a suite that needs a real cookie principal on a
   socket walks what a browser walks: `POST /gs/api/session` (201 + the session cookie), then `POST /gs/api/profile`
   (201 + the recovery key, shown once). Real HTTP, the allowed Origin, JSON. */
export const PROD_ORIGIN = "https://play.example";

export interface ApiAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** The raw body text (`""` for none). */
  text: string;
  /** The parsed body, or `null` for an empty or non-JSON one. */
  body: Record<string, unknown> | null;
}

/** One request to the same-origin API, as a browser sends it (POST, the allowed Origin, JSON) unless told otherwise. */
export function apiRequest(
  port: number,
  pathname: string,
  options: { cookie?: string; body?: object | string; origin?: string | null; contentType?: string | null; method?: string; headers?: Record<string, string> } = {},
): Promise<ApiAnswer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.origin !== null) headers.Origin = options.origin ?? PROD_ORIGIN;
    if (options.contentType !== null) headers["Content-Type"] = options.contentType ?? "application/json";
    if (options.cookie) headers.Cookie = options.cookie;
    const method = options.method ?? "POST";
    const payload = typeof options.body === "string" ? options.body : JSON.stringify(options.body ?? {});
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += String(chunk)));
      res.on("end", () => {
        let body: Record<string, unknown> | null = null;
        try {
          body = text === "" ? null : (JSON.parse(text) as Record<string, unknown>);
        } catch {
          body = null;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body });
      });
    });
    req.on("error", reject);
    if (method === "GET" || method === "HEAD") req.end();
    else req.end(payload);
  });
}

/** The cookie one Set-Cookie delivered, as the browser sends it back (`name=value`), or `null` when none was set. */
export function cookieFromAnswer(answer: ApiAnswer): string | null {
  const set = answer.headers["set-cookie"];
  if (!set || set.length !== 1) return null;
  return set[0].split(";")[0];
}

/** A fresh browser: `POST /gs/api/session` with no cookie -- 201 and a new, UNPROFILED principal's cookie. */
export async function bootstrapCookie(port: number, origin: string = PROD_ORIGIN): Promise<string> {
  const answer = await apiRequest(port, "/gs/api/session", { origin });
  const cookie = cookieFromAnswer(answer);
  if (answer.status !== 201 || cookie === null) throw new Error(`bootstrap: expected 201 + a cookie, got ${answer.status} ${answer.text}`);
  return cookie;
}

export interface ProfiledBrowser {
  /** The session cookie (`__Host-gs_session=v1.se_….<secret>`), unchanged by the profile's creation. */
  cookie: string;
  /** The recovery key, as the one response that delivers it showed it. */
  recoveryKey: string;
  /** The profile's display name as the server cleaned it. */
  name: string;
}

/** LIVE-2E: "bootstrap + create profile + cookie" over real HTTP -- a browser that may now open game sockets. */
export async function profiledBrowser(port: number, name = "Player", origin: string = PROD_ORIGIN): Promise<ProfiledBrowser> {
  const cookie = await bootstrapCookie(port, origin);
  const created = await apiRequest(port, "/gs/api/profile", { cookie, body: { name }, origin });
  if (created.status !== 201 || created.body === null) throw new Error(`create profile: expected 201, got ${created.status} ${created.text}`);
  const profile = created.body.profile as { name: string };
  return { cookie, recoveryKey: created.body.recoveryKey as string, name: profile.name };
}

/** `profiledBrowser`, when only the cookie is wanted. */
export async function profiledCookie(port: number, name = "Player", origin: string = PROD_ORIGIN): Promise<string> {
  return (await profiledBrowser(port, name, origin)).cookie;
}

/** The session id (`se_…`) a session cookie carries -- for `server.identity.peekSession` and the socket indexes. */
export const sessionIdOfCookie = (cookie: string): string => cookie.split("=")[1].split(".")[1];

/** A session cookie as the identity service reads it. */
export const cookieRead = (cookie: string) => ({ kind: "session" as const, sessionId: sessionIdOfCookie(cookie), secret: cookie.split(".")[2] });

/** A session built exactly as the server builds one, for computing logs and boards outside it. LIVE-4 (L4-2): with a
 *  pool's continuation answers when given (`continuationWiring.ts` `sessionFor`), else the session's own gameplay half. */
export function probeSession(tag = "probe", continuation?: SessionContinuation): RoomSession {
  let n = 0;
  return new RoomSession({
    ...(continuation !== undefined ? { continuation } : {}),
    providers: sandboxReplayProviders(),
    seed: {
      state: withEmptyRoster(sandboxScenarioState(DEFAULT_SANDBOX_SCENARIO, 0, "default")),
      waterfall: waterfallForRoster(sandboxWaterfallState(sandboxScenario(DEFAULT_SANDBOX_SCENARIO).phase, 0, true), []),
    },
    build: BUILD,
    mintId: () => `${tag}-${(n += 1)}`,
    now: () => 1_000 + n,
  });
}

/** A stored log: the deal, and `buys` purchases alternating from the first seat. Seated as `seedGame` seats a game
 *  (ALICE, BOB), so the pair is a dealt game a restarted server finds on disk. */
export function storedLog(buys = 0): ServerLogEntry[] {
  const session = probeSession("stored");
  session.submit({ actor: ALICE, build: BUILD, msg: SETUP as never, baseIndex: -1, submissionId: "stored-deal" });
  for (let n = 0; n < buys; n += 1) {
    const seat = session.state.player_addresses[n % 2];
    const result = session.submit({ actor: seat, build: BUILD, msg: BUY as never, baseIndex: session.nextIndex - 1, submissionId: `stored-buy-${n}` });
    if (result.kind !== "applied") throw new Error(`stored buy ${n} was ${result.kind}`);
  }
  return [...session.entries];
}
