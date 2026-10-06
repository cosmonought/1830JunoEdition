// server/src/rooms/l6_1Routing.test.ts
//
// LIVE-6 L6-1: route destinations and route frames, over real sockets and memory stores (the DynamoDB composition is
// `persistence/conformance/l6_1Routing.dynamoLocal.test.ts`, the runtime's order `aws/runtime/l5_7AwsRuntime.test.ts`).
//
//   THE PRIMARY (a POOL-ownership game server; the claim is scripted to be refused `GameRoutedError`):
//     - a protocol-1 socket (`ok` connection verdict) whose principal may read the game gets LIVE-4's route frame naming
//       the owner's TRUSTED path, then close 4426 -- for the log hello and the room hello; nothing of the game is read
//       but its record, and nothing is served;
//     - the legacy wire (no announcement) gets exactly its pre-LIVE-6 answer, never a route frame or 4426;
//     - an outsider of a private game, and an id with no game, get what no game answers; an operator run's game, a pool
//       with no destination, and a server with no route table answer exactly as before;
//     - the destination never comes from the client: not from a frame field (the closed schema refuses it), a query
//       parameter, a Host / X-Forwarded-Host header; the frame carries paths only;
//     - a client the connection verdict refuses is told `reload` (4426), never a route;
//     - the server answers its own pool's configured socket path, and no other pool's.
//   THE NON-PRIMARY ROUTER (`routerServer.ts`, production identity through the VERIFIER over the writer's records):
//     - authentication before anything: no cookie / an unknown one 401, the records unreadable 503; a session revoked
//       after the upgrade is closed 4401 at its next frame, before any route;
//     - a game owned elsewhere is routed to its owner; a released game to the primary; no owner, damage, an unreadable
//       routing, this pool itself, an operator run or no destination: `unavailable` -- nothing guessed;
//     - the legacy wire never gets a route; an unaccepted protocol gets `reload`; every other frame is `unavailable`;
//     - it writes nothing: no record, no claim, no identity change.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

import { createGameServer } from "../gameServer";
import { createRouterServer, ROUTER_UNAVAILABLE_SENTENCE } from "../routerServer";
import { readSessionCookie, sessionSetCookie } from "../identity/cookies";
import { IdentityService } from "../identity/sessions";
import { createAccountWith, keplrAccount } from "../testSupport/authorizationWallets";
import { createMemoryIdentityStore, type Session } from "../identity/store";
import { createSessionVerifier, type IdentityRecordReader } from "../identity/verifier";
import { thisDeploymentCapability } from "../deploymentCapability";
import { clientAnnouncementQuery } from "../../../frontend/src/gameEngine/compat/clientCompatibility";
import { CLIENT_ANSWER_CLOSE_CODE, CLIENT_ANSWER_SENTENCES } from "../../../frontend/src/utils/clientAnswers";
import { GameRoutedError, type ClaimAnswer, type GameOwnership } from "./gameOwnership";
import { NO_ROUTES, poolRoutes, routeEntryProblem, routeOfGame, type GameOwnerRead } from "./gameRoutes";
import { UNAVAILABLE_PLAYER_SENTENCE } from "./lifecycle";
import { createMemoryRecordStore, type RecordStore } from "./recordStore";
import type { GameRecord } from "./gameRecord";
import { ALICE, BOB, CAROL, DEV_ORIGIN, controlledStore, devIdentity, quietConsole, seededRecord, startServer, stopServer, storedLog, until } from "./testSupport";

quietConsole();

const P1 = announce([11]);
function announce(rules: readonly number[]): string {
  return clientAnnouncementQuery(1, rules, "tab-build");
}
const ROUTES = poolRoutes("pool-a", { "pool-a": { wsPath: "/gs/p/pool-a" }, "pool-b": { wsPath: "/gs/p/pool-b" }, "pool-c": { wsPath: "/gs/p/pool-c", bundlePath: "/r/old-release/" } });

interface Frame {
  kind: string;
  [key: string]: unknown;
}

/** A raw socket (any URL, any headers), recording every frame and its close code. */
class Sock {
  readonly frames: Frame[] = [];
  readonly closed: Promise<number>;
  private constructor(readonly socket: WebSocket) {
    this.closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
    socket.on("message", (raw) => this.frames.push(JSON.parse(String(raw)) as Frame));
  }
  static open(url: string, options: { origin: string; headers?: Record<string, string> }): Promise<Sock> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { origin: options.origin, headers: options.headers ?? {} });
      const sock = new Sock(socket);
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) => reject(Object.assign(new Error(`upgrade refused ${response.statusCode}`), { status: response.statusCode })));
      socket.once("open", () => resolve(sock));
    });
  }
  send(frame: object): void {
    this.socket.send(JSON.stringify(frame));
  }
  hello(gameId: string): void {
    this.send({ kind: "hello", gameId, build: "live3a-build", baseIndex: -1 });
  }
  roomHello(gameId: string): void {
    this.send({ kind: "room-hello", gameId });
  }
  async next(predicate: (frame: Frame) => boolean, label: string): Promise<Frame> {
    await until(() => this.frames.some(predicate), `${label} (saw ${this.frames.map((f) => f.kind).join(",") || "nothing"})`);
    return this.frames.find(predicate) as Frame;
  }
  async closeCode(label: string, ms = 5_000): Promise<number> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.closed, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${label}: still open (${this.frames.map((f) => f.kind).join(",")})`)), ms)))]);
    } finally {
      clearTimeout(timer);
    }
  }
  get open(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }
  close(): void {
    this.socket.terminate();
  }
}

const upgradeStatus = async (url: string, options: { origin: string; headers?: Record<string, string> }): Promise<number> => {
  try {
    const sock = await Sock.open(url, options);
    sock.close();
    return 101;
  } catch (error) {
    return (error as { status?: number }).status ?? 0;
  }
};

const devUrl = (port: number, claim: string, query = "", path = "/") => `ws://127.0.0.1:${port}${path}?dev_claim=${encodeURIComponent(claim)}${query === "" ? "" : `&${query}`}`;
const firstAnswer = (sock: Sock, label: string) => sock.next((f) => ["route", "error", "catch-up", "incompatible", "room", "reload"].includes(f.kind), label);

/* ---------------------------------------------------------------------------
    The primary: a game another pool owns
   --------------------------------------------------------------------------- */

function routedOwnership(ownerOf: (gameId: string) => string | null) {
  const claims: string[] = [];
  const ownership: GameOwnership = {
    mode: "pool",
    async claim(gameId): Promise<ClaimAnswer> {
      claims.push(gameId);
      const owner = ownerOf(gameId);
      if (owner !== null) throw new GameRoutedError(gameId, owner);
      return { kind: "claimed" };
    },
    release: () => undefined,
    onFenced: () => undefined,
  };
  return { ownership, claims };
}

async function primaryWorld(options: { routes?: boolean; owner?: string; private?: boolean } = {}) {
  const control = controlledStore();
  const records = createMemoryRecordStore();
  const record: GameRecord = { ...seededRecord([ALICE, BOB], { dealt: true }), ...(options.private === true ? { visibility: "private" as const } : {}) };
  assert.equal((await records.put(record, null)).kind, "committed");
  control.logs.set(record.game_id, storedLog(0));
  const puts = { count: 0 };
  const put = records.put.bind(records);
  records.put = async (next, expected) => {
    puts.count += 1;
    return put(next, expected);
  };
  const owned = routedOwnership(() => options.owner ?? "pool-b");
  const { server, port } = await startServer({ store: control.store, records, ownership: owned.ownership, ...(options.routes === false ? {} : { routes: ROUTES }) });
  await server.lifecycle.ready;
  return { server, port, control, records, gameId: record.game_id, owned, puts };
}

describe("L6-1 at the primary: a game another pool owns gets LIVE-4's route frame to its owner's trusted path", () => {
  test("protocol 1: the log hello and the room hello are each answered with the route frame, then 4426 -- nothing of the game is read but its record, nothing written", async () => {
    const { server, port, control, gameId, owned, puts } = await primaryWorld();
    try {
      const loadsBefore = control.calls.loadLog;
      for (const which of ["hello", "room-hello"] as const) {
        const tab = await Sock.open(devUrl(port, ALICE, P1), { origin: DEV_ORIGIN });
        if (which === "hello") tab.hello(gameId);
        else tab.roomHello(gameId);
        const route = await firstAnswer(tab, which);
        assert.deepEqual(route, { kind: "route", code: "client-rules", reason: CLIENT_ANSWER_SENTENCES.route, gameId, wsPath: "/gs/p/pool-b" }, `${which}: the frozen frame, paths only`);
        assert.equal(await tab.closeCode(which), CLIENT_ANSWER_CLOSE_CODE);
        assert.deepEqual(tab.frames.map((f) => f.kind), ["route"], `${which}: nothing else was sent`);
      }
      assert.equal(control.calls.loadLog, loadsBefore, "the routed game's log was never opened");
      assert.equal(server.residentGames(), 0, "no actor stays for a routed game");
      assert.ok(owned.claims.length >= 2, "each ask claimed first (and was refused)");
      assert.equal(puts.count, 0, "no record was written");
      assert.equal(server.clientAnswers.routed, 2);
    } finally {
      await stopServer(server);
    }
  });

  test("the session is asked again after the record read: one that ended while the read was in flight is closed 4401, never routed", async () => {
    const control = controlledStore();
    const records = createMemoryRecordStore();
    const record = seededRecord([ALICE, BOB], { dealt: true });
    await records.put(record, null);
    const clock = { now: Date.now() };
    const load = records.load.bind(records);
    records.load = async (gameId) => {
      clock.now += 365 * 24 * 60 * 60 * 1000; // the session's expiry passes while its record is read
      return load(gameId);
    };
    const owned = routedOwnership(() => "pool-b");
    const { server, port } = await startServer({ store: control.store, records, ownership: owned.ownership, routes: ROUTES, identity: devIdentity({ now: () => clock.now }) });
    try {
      await server.lifecycle.ready;
      const tab = await Sock.open(devUrl(port, ALICE, P1), { origin: DEV_ORIGIN });
      tab.hello(record.game_id);
      assert.equal(await tab.closeCode("expired mid-read"), 4401);
      assert.equal(tab.frames.some((f) => f.kind === "route"), false);
      assert.equal(server.clientAnswers.routed, 0);
    } finally {
      await stopServer(server);
    }
  });

  test("a bundle route: the owner's release is another bundle -- its bundle path rides the frame (paths only)", async () => {
    const { server, port, gameId } = await primaryWorld({ owner: "pool-c" });
    try {
      const tab = await Sock.open(devUrl(port, ALICE, P1), { origin: DEV_ORIGIN });
      tab.hello(gameId);
      const route = await firstAnswer(tab, "the hello");
      assert.deepEqual([route.kind, route.bundlePath, route.wsPath], ["route", "/r/old-release/", "/gs/p/pool-c"]);
      tab.close();
    } finally {
      await stopServer(server);
    }
  });

  test("the legacy wire keeps its answer: `unavailable`, never a route frame or 4426", async () => {
    const { server, port, gameId } = await primaryWorld();
    try {
      const legacy = await Sock.open(devUrl(port, ALICE), { origin: DEV_ORIGIN });
      legacy.hello(gameId);
      const answer = await firstAnswer(legacy, "the legacy hello");
      assert.deepEqual([answer.kind, answer.code, answer.reason], ["error", "unavailable", UNAVAILABLE_PLAYER_SENTENCE]);
      legacy.roomHello(gameId);
      await until(() => legacy.frames.length >= 2, "the legacy room hello's answer");
      assert.deepEqual(legacy.frames.map((f) => f.kind), ["error", "error"]);
      assert.equal(legacy.open, true, "not closed 4426");
      legacy.close();
    } finally {
      await stopServer(server);
    }
  });

  test("authorization before the route: an outsider of a private game, and an id with no game, get what no game answers", async () => {
    const { server, port, gameId, records } = await primaryWorld({ private: true });
    try {
      const outsider = await Sock.open(devUrl(port, CAROL, P1), { origin: DEV_ORIGIN });
      outsider.hello(gameId);
      const answer = await firstAnswer(outsider, "the outsider");
      assert.deepEqual([answer.kind, answer.code], ["error", "not-found"]);
      assert.equal(outsider.frames.some((f) => f.kind === "route"), false);
      /* A seated player of the same private game is routed. */
      const seated = await Sock.open(devUrl(port, BOB, P1), { origin: DEV_ORIGIN });
      seated.hello(gameId);
      assert.equal((await firstAnswer(seated, "the seated player")).kind, "route");
      /* An id whose record is gone. */
      (records as RecordStore & { records: Map<string, GameRecord> }).records.delete(gameId);
      const late = await Sock.open(devUrl(port, BOB, P1), { origin: DEV_ORIGIN });
      late.hello(gameId);
      assert.deepEqual([(await firstAnswer(late, "no record")).kind, late.frames[0].code], ["error", "not-found"]);
      outsider.close();
      late.close();
    } finally {
      await stopServer(server);
    }
  });

  test("no destination, no route: an operator run, a pool the table does not expose, and a server with no route table answer exactly as before", async () => {
    for (const [label, options] of [
      ["an operator run", { owner: "op:run-7" }],
      ["an unexposed pool", { owner: "pool-z" }],
      ["no route table", { routes: false }],
    ] as const) {
      const { server, port, gameId } = await primaryWorld(options);
      try {
        const tab = await Sock.open(devUrl(port, ALICE, P1), { origin: DEV_ORIGIN });
        tab.hello(gameId);
        const answer = await firstAnswer(tab, label);
        assert.deepEqual([answer.kind, answer.code], ["error", "unavailable"], label);
        assert.equal(tab.open, true, `${label}: not closed`);
        tab.close();
      } finally {
        await stopServer(server);
      }
    }
  });

  test("the destination never comes from the client: a frame field is refused by the schema; a query parameter or a Host header changes nothing", async () => {
    const { server, port, gameId } = await primaryWorld();
    try {
      /* (Host / X-Forwarded-* headers are the production router's case below: the development authenticator refuses any
         request that is not plainly loopback, so it could not even open here.) */
      const tab = await Sock.open(devUrl(port, ALICE, `${P1}&wsPath=${encodeURIComponent("//evil.example/x")}&bundlePath=%2F%2Fevil.example`), { origin: DEV_ORIGIN });
      tab.send({ kind: "hello", gameId, build: "live3a-build", baseIndex: -1, wsPath: "//evil.example/x" });
      const refused = await firstAnswer(tab, "a hello with a destination in it");
      assert.deepEqual([refused.kind, refused.code], ["error", "bad-frame"], "the closed schema refuses the field");
      tab.hello(gameId);
      const route = await tab.next((f) => f.kind === "route", "the route");
      assert.equal(route.wsPath, "/gs/p/pool-b");
      assert.equal("bundlePath" in route, false);
      assert.deepEqual(Object.keys(route).sort(), ["code", "gameId", "kind", "reason", "wsPath"], "paths only: no host, no scheme, nothing else");
      tab.close();
    } finally {
      await stopServer(server);
    }
  });

  test("a client the frozen connection verdict refuses is told `reload` (4426) and never routed", async () => {
    const { server, port, gameId } = await primaryWorld();
    try {
      const future = await Sock.open(devUrl(port, ALICE, "cp=9&cr=11"), { origin: DEV_ORIGIN });
      future.hello(gameId);
      assert.equal(await future.closeCode("an unaccepted protocol"), CLIENT_ANSWER_CLOSE_CODE);
      assert.deepEqual(future.frames.map((f) => f.kind), ["reload"]);
      const broken = await Sock.open(devUrl(port, ALICE, "cp=1"), { origin: DEV_ORIGIN });
      broken.hello(gameId);
      assert.equal(await broken.closeCode("an unreadable announcement"), CLIENT_ANSWER_CLOSE_CODE);
      assert.deepEqual([broken.frames[0].kind, broken.frames[0].code], ["reload", "client-announcement"]);
    } finally {
      await stopServer(server);
    }
  });

  test("the server answers its own pool's configured socket path, and no other pool's", async () => {
    const { server, port } = await primaryWorld();
    try {
      assert.equal(await upgradeStatus(devUrl(port, ALICE, P1, "/gs/p/pool-a"), { origin: DEV_ORIGIN }), 101);
      assert.equal(await upgradeStatus(devUrl(port, ALICE, P1, "/gs/p/pool-b"), { origin: DEV_ORIGIN }), 404);
    } finally {
      await stopServer(server);
    }
    const plain = await primaryWorld({ routes: false });
    try {
      assert.equal(await upgradeStatus(devUrl(plain.port, ALICE, P1, "/gs/p/pool-a"), { origin: DEV_ORIGIN }), 404, "no route table: `/gs` (and development's `/`) only, as before");
    } finally {
      await stopServer(plain.server);
    }
  });
});

describe("L6-1 the trusted route table and the lookup", () => {
  test("only plain paths under the rules are accepted; a task never routes to itself or to an operator run", () => {
    for (const bad of ["//evil.example/gs", "https://evil.example/gs/p/x", "/gs/../x", "/gs/p/%2e%2e", "/gs/p/x?y=1", "/gs/p/x#y", "/other/p/x", "gs/p/x", "/gs/p\\x", `/gs/${"a".repeat(300)}`]) {
      assert.notEqual(routeEntryProblem({ wsPath: bad }), null, bad);
    }
    assert.notEqual(routeEntryProblem({ wsPath: "/gs/p/x", bundlePath: "//evil.example/" }), null);
    assert.notEqual(routeEntryProblem({ wsPath: "/gs/p/x", bundlePath: "/gs/p/y" }), null, "a bundle is a page path");
    assert.equal(routeEntryProblem({ wsPath: "/gs/p/x", bundlePath: "/r/11/" }), null);
    assert.throws(() => poolRoutes("a", { a: { wsPath: "/gs/p/a" }, b: { wsPath: "/gs/p/a" } }), /another pool's/);
    assert.equal(ROUTES.destinationOf("pool-a"), null, "never itself");
    assert.equal(ROUTES.destinationOf("op:run-1"), null);
    assert.equal(ROUTES.destinationOf("pool-z"), null);
    assert.deepEqual(ROUTES.ownWsPaths, ["/gs/p/pool-a"]);
    assert.deepEqual(NO_ROUTES.ownWsPaths, []);
  });

  test("routeOfGame: the HEAD's owner, a released game's primary -- and nothing guessed from anything that cannot be read", async () => {
    const directory = (owner: GameOwnerRead | "throws", primary: string | null | "throws") => ({
      ownerOf: async () => {
        if (owner === "throws") throw new Error("damaged HEAD");
        return owner;
      },
      primaryPool: async () => {
        if (primary === "throws") throw new Error("RoutingUnreadableError");
        return primary;
      },
    });
    const at = (owner: GameOwnerRead | "throws", primary: string | null | "throws") => routeOfGame("g_x", directory(owner, primary), ROUTES);
    assert.deepEqual(await at({ kind: "owned", pool: "pool-b" }, "throws"), { kind: "route", pool: "pool-b", destination: { wsPath: "/gs/p/pool-b" } }, "an owned game never needs the routing");
    assert.deepEqual(await at({ kind: "released" }, "pool-b"), { kind: "route", pool: "pool-b", destination: { wsPath: "/gs/p/pool-b" } });
    assert.deepEqual(await at({ kind: "released" }, null), { kind: "none", why: "no-primary" });
    assert.deepEqual(await at({ kind: "released" }, "throws"), { kind: "none", why: "unreadable" });
    assert.deepEqual(await at("throws", "pool-b"), { kind: "none", why: "unreadable" });
    assert.deepEqual(await at({ kind: "absent" }, "pool-b"), { kind: "none", why: "absent" });
    assert.deepEqual(await at({ kind: "owned", pool: "op:run-2" }, "pool-b"), { kind: "none", why: "operator" });
    assert.deepEqual(await at({ kind: "owned", pool: "pool-a" }, "pool-b"), { kind: "none", why: "self" });
    assert.deepEqual(await at({ kind: "owned", pool: "pool-z" }, "pool-b"), { kind: "none", why: "no-destination" });
    assert.deepEqual(await at({ kind: "released" }, "pool-a"), { kind: "none", why: "self" });
  });
});

/* ---------------------------------------------------------------------------
    The non-primary router, authenticated by the verifier over the writer's records
   --------------------------------------------------------------------------- */

const ORIGIN = "https://play.example";
const T0 = Date.now();

async function routerWorld(options: { readonly delayMs?: number; readonly limits?: import("../ingress/limits").IngressLimitOverrides } = {}) {
  /* The writer (the primary's identity service) and the durable records it commits. */
  const store = createMemoryIdentityStore();
  const writer = await IdentityService.open(store, { policy: { passwordKdf: { logN: 10, r: 1, p: 1 } } });
  const reads = { count: 0, fail: false };
  const pick = <T>(list: T[], match: (record: T) => boolean): T | null => list.find(match) ?? null;
  const reader: IdentityRecordReader = {
    session: async (id) => {
      reads.count += 1;
      if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (reads.fail) throw new Error("the identity table did not answer (injected)");
      return pick(store.snapshot().sessions, (r) => r.session_id === id);
    },
    principal: async (id) => pick(store.snapshot().principals, (r) => r.principal_id === id),
    family: async (id) => pick(store.snapshot().families, (r) => r.family_id === id),
    profile: async (id) => pick(store.snapshot().profiles, (r) => r.profile_id === id),
  };
  const cookieOf = async (name: string) => {
    const boot = await writer.bootstrap({ kind: "none" }, false, T0);
    /* PHASE 3 FINAL: an account (username, password, Authorization Wallet); the create signs this browser in on a FRESH
       session (the bootstrap's is replaced), so the cookie is the create's. */
    const created = await createAccountWith(
      writer,
      readSessionCookie((boot as { setCookie: string }).setCookie.split(";")[0]),
      { username: name.toLowerCase(), password: "correct horse battery", displayName: name, wallet: keplrAccount(`l6-1/${name}`) },
      T0,
    );
    assert.equal(created.kind, "ok", JSON.stringify(created));
    const setCookie = (created as { setCookie: string }).setCookie;
    const read = readSessionCookie(setCookie.split(";")[0]);
    const sessionId = read.kind === "session" ? read.sessionId : "";
    const principalId = (writer.peekSession(sessionId) as Session).principal_id;
    return { cookie: setCookie.split(";")[0], sessionId, principalId };
  };
  const ann = await cookieOf("Ann");
  const bob = await cookieOf("Bob");
  const cat = await cookieOf("Cat");
  /* The games, as records a seated principal can read (Ann and Bob seated; the private one keeps Cat out). */
  const records = createMemoryRecordStore();
  const recordWrites = { count: 0 };
  const seed = async (visibility: "public" | "private") => {
    const base = seededRecord([ALICE, BOB], { dealt: true });
    const record: GameRecord = {
      ...base,
      visibility,
      seats: base.seats.map((seat, at) => ({ ...seat, principal_id: at === 0 ? ann.principalId : bob.principalId })),
    } as GameRecord;
    assert.equal((await records.put(record, null)).kind, "committed");
    return record.game_id;
  };
  const owned = await seed("private");
  const released = await seed("public");
  const nobody = await seed("public");
  const damaged = await seed("public");
  const mine = await seed("public");
  const operator = await seed("public");
  const put = records.put.bind(records);
  records.put = async (next, expected) => {
    recordWrites.count += 1;
    return put(next, expected);
  };
  const owners = new Map<string, GameOwnerRead | "throws">([
    [owned, { kind: "owned", pool: "pool-b" }],
    [released, { kind: "released" }],
    [damaged, "throws"],
    [mine, { kind: "owned", pool: "pool-a" }],
    [operator, { kind: "owned", pool: "op:run-3" }],
  ]);
  const routing = { primary: "pool-c" as string | null | "throws" };
  const router = createRouterServer({
    port: 0,
    bindHost: "127.0.0.1",
    build: "l6-1-router",
    identity: { allowedOrigins: [ORIGIN], trustedProxyHops: 0, verifier: createSessionVerifier(reader) },
    capability: thisDeploymentCapability([]),
    routes: ROUTES,
    directory: {
      ownerOf: async (gameId) => {
        const owner = owners.get(gameId);
        if (owner === "throws") throw new Error("the HEAD is damaged (injected)");
        return owner ?? { kind: "absent" };
      },
      primaryPool: async () => {
        if (routing.primary === "throws") throw new Error("RoutingUnreadableError (injected)");
        return routing.primary;
      },
    },
    records,
    readiness: () => ({ ready: true, reasons: [], detail: { role: "non-primary" } }),
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    log: () => undefined,
    warn: () => undefined,
  });
  await new Promise<void>((resolve) => (router.http.listening ? resolve() : router.http.once("listening", () => resolve())));
  const address = router.http.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const url = (query = P1, path = "/gs") => `ws://127.0.0.1:${port}${path}${query === "" ? "" : `?${query}`}`;
  const open = (cookie: string, query = P1, path = "/gs") => Sock.open(url(query, path), { origin: ORIGIN, headers: { Cookie: cookie } });
  return { store, writer, reads, router, port, url, open, ann, bob, cat, games: { owned, released, nobody, damaged, mine, operator }, routing, recordWrites, commits: () => store.stats.commits };
}

describe("L6-1 the non-primary router: authenticated by the verifier, it routes and changes nothing", () => {
  test("authentication first: no cookie, an unknown or forged one 401; the records unreadable 503; a profiled session 101", async () => {
    const w = await routerWorld();
    try {
      assert.equal(await upgradeStatus(w.url(), { origin: ORIGIN }), 401, "no cookie");
      const forged = sessionSetCookie(w.ann.sessionId, "A".repeat(43)).split(";")[0];
      assert.equal(await upgradeStatus(w.url(), { origin: ORIGIN, headers: { Cookie: forged } }), 401, "a wrong secret");
      assert.equal(await upgradeStatus(w.url(), { origin: "https://evil.example", headers: { Cookie: w.ann.cookie } }), 403, "Origin before the session");
      w.reads.fail = true;
      assert.equal(await upgradeStatus(w.url(), { origin: ORIGIN, headers: { Cookie: w.ann.cookie } }), 503, "the records could not be read: fail closed");
      w.reads.fail = false;
      assert.equal(await upgradeStatus(w.url(), { origin: ORIGIN, headers: { Cookie: w.ann.cookie } }), 101);
      assert.equal(await upgradeStatus(w.url(P1, "/gs/p/pool-a"), { origin: ORIGIN, headers: { Cookie: w.ann.cookie } }), 101, "its own pool's path");
      assert.equal(await upgradeStatus(w.url(P1, "/gs/p/pool-b"), { origin: ORIGIN, headers: { Cookie: w.ann.cookie } }), 404, "never another pool's");
    } finally {
      await w.router.close();
    }
  });

  test("the socket caps hold across the verifier's await: upgrades racing the reads are counted again before they register", async () => {
    const w = await routerWorld({ delayMs: 40, limits: { identity: { maxSocketsPerIp: 2, maxSocketsPerSession: 50, maxSocketsPerPrincipal: 50 } } });
    try {
      /* Every admitted socket stays open until all six are decided (a closed one would free its place). */
      const opened = await Promise.all(
        Array.from({ length: 6 }, () =>
          Sock.open(w.url(), { origin: ORIGIN, headers: { Cookie: w.ann.cookie } }).then(
            (sock) => ({ status: 101, sock }),
            (error: { status?: number }) => ({ status: error.status ?? 0, sock: null }),
          ),
        ),
      );
      const statuses = opened.map((entry) => entry.status);
      for (const entry of opened) entry.sock?.close();
      assert.equal(statuses.filter((status) => status === 101).length, 2, `exactly the address's cap was admitted (${statuses.join(",")})`);
      assert.equal(statuses.filter((status) => status === 429).length, 4, `the rest were refused by the cap after the reads (${statuses.join(",")})`);
    } finally {
      await w.router.close();
    }
  });

  test("a game owned elsewhere is routed to its owner; a released one to the primary -- after authorization; outsiders and unknown ids get not-found", async () => {
    const w = await routerWorld();
    try {
      const commits = w.commits();
      /* Nothing the client sends names the destination: not the query, not Host / X-Forwarded-Host / -Proto. */
      const tab = await Sock.open(w.url(`${P1}&wsPath=${encodeURIComponent("//evil.example/")}`), {
        origin: ORIGIN,
        headers: { Cookie: w.ann.cookie, Host: "evil.example", "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "http" },
      });
      tab.hello(w.games.owned);
      assert.deepEqual(await firstAnswer(tab, "owned"), { kind: "route", code: "client-rules", reason: CLIENT_ANSWER_SENTENCES.route, gameId: w.games.owned, wsPath: "/gs/p/pool-b" });
      assert.equal(await tab.closeCode("routed"), CLIENT_ANSWER_CLOSE_CODE);
      const room = await w.open(w.bob.cookie);
      room.roomHello(w.games.released);
      const toPrimary = await firstAnswer(room, "released");
      assert.deepEqual([toPrimary.kind, toPrimary.wsPath, toPrimary.bundlePath], ["route", "/gs/p/pool-c", "/r/old-release/"], "the primary's trusted entry");
      const outsider = await w.open(w.cat.cookie);
      outsider.hello(w.games.owned);
      assert.deepEqual([(await firstAnswer(outsider, "outsider")).kind, outsider.frames[0].code], ["error", "not-found"]);
      outsider.hello(seededRecord([ALICE]).game_id); // a well-formed id no record has
      await until(() => outsider.frames.length >= 2, "the unknown id's answer");
      assert.deepEqual([outsider.frames[1].kind, outsider.frames[1].code], ["error", "not-found"]);
      outsider.close();
      assert.equal(w.router.counters.routed, 2);
      assert.equal(w.recordWrites.count, 0, "no record written");
      assert.equal(w.commits(), commits, "no identity change");
    } finally {
      await w.router.close();
    }
  });

  test("nothing guessed: no owner, damage, an unreadable or absent routing, this pool, an operator run -- `unavailable`", async () => {
    const w = await routerWorld();
    try {
      const ask = async (gameId: string, label: string) => {
        const tab = await w.open(w.ann.cookie);
        tab.hello(gameId);
        const answer = await firstAnswer(tab, label);
        assert.deepEqual([answer.kind, answer.code, answer.reason], ["error", "unavailable", UNAVAILABLE_PLAYER_SENTENCE], label);
        assert.equal(tab.frames.some((f) => f.kind === "route"), false, label);
        tab.close();
      };
      await ask(w.games.nobody, "no HEAD");
      await ask(w.games.damaged, "a damaged HEAD");
      await ask(w.games.mine, "owned by this pool");
      await ask(w.games.operator, "an operator run");
      w.routing.primary = "throws";
      await ask(w.games.released, "a released game, the routing unreadable");
      w.routing.primary = null;
      await ask(w.games.released, "a released game, no routing");
      w.routing.primary = "pool-z";
      await ask(w.games.released, "a released game, a primary with no destination");
      assert.equal(w.router.counters.routed, 0);
    } finally {
      await w.router.close();
    }
  });

  test("the client rules are LIVE-4's: the legacy wire is never routed; an unaccepted protocol is told reload; other frames are unavailable", async () => {
    const w = await routerWorld();
    try {
      const legacy = await w.open(w.ann.cookie, "");
      legacy.hello(w.games.owned);
      const answer = await firstAnswer(legacy, "legacy");
      assert.deepEqual([answer.kind, answer.code], ["error", "unavailable"]);
      assert.equal(legacy.open, true);
      legacy.close();
      const future = await w.open(w.ann.cookie, "cp=9&cr=11");
      future.hello(w.games.owned);
      assert.equal(await future.closeCode("unaccepted"), CLIENT_ANSWER_CLOSE_CODE);
      assert.deepEqual(future.frames.map((f) => f.kind), ["reload"]);
      const tab = await w.open(w.ann.cookie);
      tab.send({ kind: "rooms-watch", on: true });
      tab.send({ kind: "room-op", requestId: "r1", op: { kind: "create", visibility: "public" } });
      await until(() => tab.frames.length >= 2, "two answers");
      assert.deepEqual([tab.frames[0].kind, tab.frames[0].code, tab.frames[0].reason], ["error", "unavailable", ROUTER_UNAVAILABLE_SENTENCE]);
      /* The room operation: refused (never performed) -- an ack refusing it, or the schema's own refusal. */
      assert.ok((tab.frames[1].kind === "room-ack" && tab.frames[1].ok === false) || (tab.frames[1].kind === "error" && tab.frames[1].code === "bad-frame"), JSON.stringify(tab.frames[1]));
      tab.close();
      assert.equal(w.recordWrites.count, 0);
    } finally {
      await w.router.close();
    }
  });

  test("a session revoked after the upgrade is closed 4401 at its next frame -- before any route", async () => {
    const w = await routerWorld();
    try {
      const tab = await w.open(w.ann.cookie);
      assert.equal(await w.writer.revoke(w.ann.sessionId, "logout", Date.now()), true, "the writer commits the logout");
      tab.hello(w.games.owned);
      assert.equal(await tab.closeCode("revoked"), 4401);
      assert.equal(tab.frames.some((f) => f.kind === "route"), false);
      /* A disabled principal's socket: the same. */
      const bob = await w.open(w.bob.cookie);
      assert.equal(await w.writer.disablePrincipal(w.bob.principalId, Date.now()), true);
      bob.roomHello(w.games.released);
      assert.equal(await bob.closeCode("disabled"), 4401);
      /* The records unreadable at a frame: the frame is answered unavailable, nothing routed. */
      const cat = await w.open(w.cat.cookie);
      w.reads.fail = true;
      cat.hello(w.games.released);
      const answer = await firstAnswer(cat, "unreadable at the frame");
      assert.deepEqual([answer.kind, answer.code], ["error", "unavailable"]);
      w.reads.fail = false;
      cat.close();
    } finally {
      await w.router.close();
    }
  });
});
