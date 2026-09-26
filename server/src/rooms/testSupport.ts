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

import { WebSocket } from "ws";

import { createGameServer, type GameServerIdentity, type GameServerOptions } from "../gameServer";
import { createDevAuthenticator, DEV_PRINCIPAL_PREFIX } from "../identity/devAuthenticator";
import type { IdentityLimits, RoomLimits } from "../ingress/limits";
import type { LogStore } from "../fileLogStore";
import { StoreDefiniteError } from "../persistence/storeResult";
import { RoomSession, type ServerLogEntry } from "../../../frontend/src/utils/roomSession";
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
  maxSocketsPerIp: 10_000,
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

  private constructor(
    readonly socket: WebSocket,
    readonly claim: string,
  ) {}

  static open(port: number, claim: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(devSocketUrl(port, claim), { origin: DEV_ORIGIN });
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

  submit(msg: object, over: { baseIndex: number; submissionId?: string; baseId?: string }): void {
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

/** A session built exactly as the server builds one, for computing logs and boards outside it. */
export function probeSession(tag = "probe"): RoomSession {
  let n = 0;
  return new RoomSession({
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
