// server/src/identity/live2bIdentity.test.ts
//
// LIVE-2B against the real server (`createGameServer`) over real HTTP and real WebSockets: the bootstrap and revoke
// API, the upgrade order and its refusals, the frozen socket context, revocation / eviction / rotation as they reach
// open sockets, the identity limits, the malformed-close cooldown, the startup mode lock (spawned processes), and the
// ordinary local development flow. Production-mode cases present real cookies and an Origin, as a browser does.
// LIVE-2E: profiles are mandatory, so a production case that opens a game socket first creates its browser's profile
// (PHASE 3 FINAL: an account with its Authorization Wallet, `POST /gs/api/account/create`, testSupport's `profiledCookie`). P3-ACCT (public first): an unprofiled cookie's upgrade opens
// a PUBLIC, read-only socket (LIVE-2E refused it 403 at step "profile"); the frame gate refuses everything else.
// The profile surface itself is `live2eProfiles.test.ts`.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { WebSocket } from "ws";

import type { IdentityLimits } from "../ingress/limits";
import {
  ALICE,
  BOB,
  BUILD,
  BUY,
  Client,
  DEV_ORIGIN,
  controlledStore,
  createAuthorization,
  devIdentity,
  devSocketUrl,
  openGame,
  loginOnFreshBrowser,
  profiledBrowser,
  profiledCookie,
  quietConsole,
  startServer,
  stopServer,
  until,
} from "../rooms/testSupport";
import { LEGACY_ROOM_HANDLERS } from "../gameServer";
import { mintGameId } from "../rooms/gameRecord";
import { decideUpgrade } from "./authenticateUpgrade";
import { IdentityLimiter } from "./limiter";
import { IdentityService } from "./sessions";
import { createMemoryIdentityStore } from "./store";
import { readSessionCookie } from "./cookies";
import { DEFAULT_INGRESS_LIMITS } from "../ingress/limits";
import { TEST_PASSWORD_KDF } from "../escrow/escrow4Support";
import { createAccountWith, keplrAccount } from "../testSupport/authorizationWallets";

quietConsole();

const DAY = 24 * 60 * 60 * 1000;
const PROD_ORIGIN = "https://play.example";

interface Clock {
  now: number;
}

async function prodServer(over: { clock?: Clock; limits?: Partial<IdentityLimits>; service?: IdentityService } = {}) {
  const clock = over.clock ?? { now: 1_750_000_000_000 };
  const started = await startServer({
    identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, now: () => clock.now, ...(over.service ? { service: over.service } : {}) },
    limits: { identity: { ...(over.limits ?? {}) } },
  });
  return { ...started, clock };
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(port: number, pathname: string, options: { method?: string; origin?: string | null; cookie?: string; body?: string; contentType?: string | null; headers?: Record<string, string> } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.origin !== null) headers.Origin = options.origin ?? PROD_ORIGIN;
    if (options.contentType !== null) headers["Content-Type"] = options.contentType ?? "application/json";
    if (options.cookie) headers.Cookie = options.cookie;
    const body = options.body ?? "{}";
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method: options.method ?? "POST", headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += String(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    if ((options.method ?? "POST") !== "GET") req.end(body);
    else req.end();
  });
}

/** The cookie a Set-Cookie delivered, as the browser sends it back. */
const cookieFrom = (answer: Answer): string => {
  const set = answer.headers["set-cookie"];
  assert.ok(set && set.length === 1, "one Set-Cookie");
  return set[0].split(";")[0];
};

const bootstrap = (port: number, cookie?: string, body = "{}") => request(port, "/gs/api/session", { cookie, body });

/** LIVE-2E: a browser that may open game sockets -- bootstrapped AND profiled (an unprofiled one's upgrade is 403). */
const profiled = (port: number, name = "Player") => profiledCookie(port, name, PROD_ORIGIN);

interface Upgrade {
  status: number;
  retryAfter?: string;
  socket?: WebSocket;
  frames: Array<Record<string, unknown>>;
  closed: Promise<number>;
}

function upgrade(port: number, options: { path?: string; origin?: string | null; cookie?: string; headers?: Record<string, string> } = {}): Promise<Upgrade> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.cookie) headers.Cookie = options.cookie;
    const socket = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? "/gs"}`, {
      headers,
      ...(options.origin === null ? {} : { origin: options.origin ?? PROD_ORIGIN }),
    });
    const frames: Array<Record<string, unknown>> = [];
    const closed = new Promise<number>((done) => socket.once("close", (code) => done(code)));
    socket.on("message", (raw) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
    socket.on("error", () => undefined);
    socket.once("open", () => resolve({ status: 101, socket, frames, closed }));
    socket.once("unexpected-response", (req, res) => {
      resolve({ status: res.statusCode ?? 0, retryAfter: res.headers["retry-after"] as string | undefined, frames, closed });
      res.resume();
      req.destroy();
    });
  });
}

const sessionIdOf = (cookie: string) => cookie.split("=")[1].split(".")[1];

describe("LIVE-2B bootstrap and revoke API", () => {
  test("no cookie: 201 + the frozen Set-Cookie; valid: 200 without one; no CORS header, no-store, no principal id", async () => {
    const { server, port } = await prodServer();
    try {
      const first = await bootstrap(port);
      assert.equal(first.status, 201);
      const setCookie = (first.headers["set-cookie"] ?? [])[0];
      assert.match(setCookie, /^__Host-gs_session=v1\.se_[0-9a-hjkmnp-tv-z]{25}[048cgmrw]\.[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=15552000$/);
      assert.equal(first.headers["cache-control"], "no-store");
      assert.ok(!Object.keys(first.headers).some((name) => name.startsWith("access-control")), "no CORS");
      assert.ok(!first.body.includes("pr_") && !first.body.includes("se_"), "no id on the wire");
      assert.equal(JSON.parse(first.body).profile, null, "LIVE-2E: a new browser is unprofiled -- the profile gate");
      const cookie = cookieFrom(first);
      const again = await bootstrap(port, cookie);
      assert.equal(again.status, 200);
      assert.equal(again.headers["set-cookie"], undefined);
      assert.equal(JSON.parse(again.body).profile, null);
      assert.equal(server.identity.sizes().principals, 1);
      // LIVE-2E: once profiled, the bootstrap names the profile -- by name only, never an id. PHASE 3 FINAL: the account
      // (username, password, Authorization Wallet) signs this browser in on a FRESH cookie, and the bootstrap also tells
      // the account's own session its username.
      const proof = await createAuthorization(port, cookie, "ann", keplrAccount("live2b/bootstrap-ann"), PROD_ORIGIN);
      const created = await request(port, "/gs/api/account/create", { cookie, body: JSON.stringify({ username: "ann", password: "correct horse battery", name: "Ann", ...proof }) });
      assert.equal(created.status, 201);
      const named = await bootstrap(port, cookieFrom(created));
      assert.deepEqual(JSON.parse(named.body).profile, { name: "Ann", otherSessions: 0, username: "ann" });
      assert.ok(!named.body.includes("pr_") && !named.body.includes("pf_") && !named.body.includes("se_"), "no id on the wire");
      assert.equal(server.identity.sizes().principals, 1, "the profile binds THIS browser's principal");
    } finally {
      await stopServer(server);
    }
  });

  test("the request is policed before it is read: Origin (403), method (405), media type (415), size (413), shape (400); /me/games is 2C's", async () => {
    const { server, port } = await prodServer();
    try {
      assert.equal((await request(port, "/gs/api/session", { origin: "https://evil.example" })).status, 403);
      assert.equal((await request(port, "/gs/api/session", { origin: null })).status, 403);
      assert.equal((await request(port, "/gs/api/session", { origin: "null" })).status, 403);
      assert.equal((await request(port, "/gs/api/session", { origin: `${PROD_ORIGIN}/` })).status, 403);
      assert.equal((await request(port, "/gs/api/session", { method: "GET" })).status, 405);
      assert.equal((await request(port, "/gs/api/session", { contentType: "text/plain" })).status, 415);
      assert.equal((await request(port, "/gs/api/session", { contentType: null })).status, 415);
      assert.equal((await request(port, "/gs/api/session", { body: JSON.stringify({ pad: "x".repeat(5000) }) })).status, 413);
      assert.equal((await request(port, "/gs/api/session", { body: '{"fresh":"yes"}' })).status, 400);
      assert.equal((await request(port, "/gs/api/session", { body: '{"principal":"pr_x"}' })).status, 400);
      assert.equal((await request(port, "/gs/api/me/games", { method: "GET" })).status, 404);
      const health = await request(port, "/gs/healthz", { method: "GET", origin: null, contentType: null });
      assert.equal(health.status, 200);
      assert.equal(health.body, "ok\n");
      assert.equal(server.identity.sizes().principals, 0, "nothing minted by a refused request");
    } finally {
      await stopServer(server);
    }
  });

  test("revoke: 204, the cookie cleared, every socket of the session closed 4401, and the session never comes back", async () => {
    const { server, port } = await prodServer();
    try {
      const cookie = await profiled(port);
      const a = await upgrade(port, { cookie });
      const b = await upgrade(port, { cookie });
      assert.equal(a.status, 101);
      assert.equal(b.status, 101);
      assert.equal((await request(port, "/gs/api/session/revoke", { cookie, origin: "https://evil.example" })).status, 403);
      const revoked = await request(port, "/gs/api/session/revoke", { cookie });
      assert.equal(revoked.status, 204);
      assert.match((revoked.headers["set-cookie"] ?? [])[0], /^__Host-gs_session=; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=0$/);
      assert.equal(await a.closed, 4401);
      assert.equal(await b.closed, 4401);
      assert.equal((await upgrade(port, { cookie })).status, 401);
      const after = await bootstrap(port, cookie);
      assert.equal(after.status, 401);
      assert.deepEqual(JSON.parse(after.body), { error: "session-ended", reason: "logout" });
      assert.equal(after.headers["set-cookie"], undefined, "the ended cookie is not cleared: a reload reaches the same answer");
      assert.equal((await request(port, "/gs/api/session/revoke", { cookie })).status, 401);
      const fresh = await bootstrap(port, cookie, '{"fresh":true}');
      assert.equal(fresh.status, 201, "only the explicit fresh path mints a new guest");
      assert.equal(JSON.parse(fresh.body).profile, null, "a fresh browser is unprofiled: the profile stays with its principal");
      const publicSocket = await upgrade(port, { cookie: cookieFrom(fresh) });
      assert.equal(publicSocket.status, 101, "P3-ACCT: it opens only a public, read-only socket until it signs in");
      publicSocket.socket?.terminate();
    } finally {
      await stopServer(server);
    }
  });

  test("rotation after 7 days: the open socket stays; the old cookie cannot upgrade but still bootstraps for 24 h to the same principal", async () => {
    const { server, port, clock } = await prodServer();
    try {
      const old = await profiled(port);
      const open = await upgrade(port, { cookie: old });
      assert.equal(open.status, 101);
      clock.now += 8 * DAY;
      const rotated = await bootstrap(port, old);
      assert.equal(rotated.status, 200);
      assert.equal(JSON.parse(rotated.body).rotated, true);
      const next = cookieFrom(rotated);
      assert.notEqual(next, old);
      // The socket opened on the old session is untouched, and still answered. (LIVE-2C/2D: the public list is the
      // server-owned `rooms-watch`; the legacy `lobby-hello` is registered in neither mode.)
      open.socket?.send(JSON.stringify({ kind: "rooms-watch", on: true }));
      await until(() => open.frames.some((frame) => frame.kind === "rooms"), "a lobby answer on the rotated session's socket");
      assert.equal(open.socket?.readyState, WebSocket.OPEN);
      assert.equal((await upgrade(port, { cookie: old })).status, 401, "a rotated session opens no new socket");
      const fresh = await upgrade(port, { cookie: next });
      assert.equal(fresh.status, 101);
      const lost = await bootstrap(port, old);
      assert.equal(lost.status, 200, "the grace path");
      assert.equal(server.identity.sizes().principals, 1, "every cookie on the same principal");
      assert.equal(JSON.parse(lost.body).profile.name, "Player", "and on the same profile");
      clock.now += DAY;
      assert.deepEqual(JSON.parse((await bootstrap(port, old)).body), { error: "session-ended", reason: "rotated" });
      open.socket?.terminate();
      fresh.socket?.terminate();
    } finally {
      await stopServer(server);
    }
  });

  test("eviction: the 11th active session evicts the oldest, and its open socket closes 4401", async () => {
    const { server, port, clock } = await prodServer({ limits: { graceMintsPerSession: { capacity: 100, refillPerSecond: 1 } } });
    try {
      const s0 = await profiled(port);
      clock.now += 8 * DAY;
      const successors: string[] = [];
      successors.push(cookieFrom(await bootstrap(port, s0)));
      const oldest = await upgrade(port, { cookie: successors[0] });
      assert.equal(oldest.status, 101);
      for (let n = 1; n <= 10; n += 1) {
        clock.now += 1;
        successors.push(cookieFrom(await bootstrap(port, s0)));
      }
      assert.equal(await oldest.closed, 4401);
      assert.equal(server.identity.peekSession(sessionIdOf(successors[0]))?.revoke_reason, "evicted");
      assert.equal((await upgrade(port, { cookie: successors[10] })).status, 101);
    } finally {
      await stopServer(server);
    }
  });

  test("a rotated cookie's grace successors are budgeted (burst 5): a replayed rotated cookie is not a stream of store writes", async () => {
    const { server, port, clock } = await prodServer();
    try {
      const old = cookieFrom(await bootstrap(port));
      clock.now += 8 * DAY;
      assert.equal((await bootstrap(port, old)).status, 200, "the rotation itself");
      for (let n = 0; n < 5; n += 1) assert.equal((await bootstrap(port, old)).status, 200, `grace successor ${n + 1}`);
      const limited = await bootstrap(port, old);
      assert.equal(limited.status, 429);
      assert.equal(server.identityLimiter.denied["bootstrap-grace"], 1);
    } finally {
      await stopServer(server);
    }
  });

  test("an operator disable reaches the running process: the principal's sockets close 4401 and its cookie ends", async () => {
    const { server, port, clock } = await prodServer();
    try {
      const cookie = await profiled(port);
      const socket = await upgrade(port, { cookie });
      assert.equal(socket.status, 101);
      const principalId = (server.identity.authenticate({ kind: "session", sessionId: sessionIdOf(cookie), secret: cookie.split(".")[2] }, clock.now) as { principalId: string }).principalId;
      await server.identity.disablePrincipal(principalId, clock.now);
      assert.equal(await socket.closed, 4401);
      assert.deepEqual(JSON.parse((await bootstrap(port, cookie)).body), { error: "session-ended", reason: "principal-disabled" });
    } finally {
      await stopServer(server);
    }
  });
});

describe("LIVE-2B upgrade", () => {
  test("each refusal class, before any WebSocket exists: 404, 403, 401, and a forged or malformed cookie is 401", async () => {
    const { server, port } = await prodServer();
    try {
      const cookie = await profiled(port);
      assert.equal((await upgrade(port, { path: "/", cookie })).status, 404, "production accepts /gs only");
      assert.equal((await upgrade(port, { path: "/gs/", cookie })).status, 404);
      assert.equal((await upgrade(port, { cookie, origin: "https://evil.example" })).status, 403);
      assert.equal((await upgrade(port, { cookie, origin: null })).status, 403, "a missing Origin");
      assert.equal((await upgrade(port, { cookie, origin: "null" })).status, 403);
      assert.equal((await upgrade(port, {})).status, 401, "no cookie");
      const forged = cookie.replace(/\.[^.]+$/, `.${"A".repeat(43)}`);
      assert.equal((await upgrade(port, { cookie: forged })).status, 401);
      assert.equal((await upgrade(port, { cookie: `${cookie}; ${cookie}` })).status, 401, "a duplicate cookie");
      assert.equal((await upgrade(port, { path: "/gs?dev_claim=p-alice" })).status, 401, "production ignores a dev claim");
      // P3-ACCT: an authenticated but UNPROFILED browser opens a PUBLIC socket (LIVE-2E refused it 403) -- and a dev
      // claim beside its cookie changes nothing about who it is.
      const unprofiled = cookieFrom(await bootstrap(port));
      const publicOne = await upgrade(port, { cookie: unprofiled });
      assert.equal(publicOne.status, 101);
      publicOne.socket?.terminate();
      const withClaim = await upgrade(port, { path: "/gs?dev_claim=p-alice", cookie: unprofiled });
      assert.equal(withClaim.status, 101);
      withClaim.socket?.terminate();
      assert.equal(server.upgrades.refused["profile:403"], undefined);
      assert.equal(server.upgrades.accepted, 2);
      const ok = await upgrade(port, { cookie });
      assert.equal(ok.status, 101);
      ok.socket?.terminate();
    } finally {
      await stopServer(server);
    }
  });

  test("the order is frozen: the first failing step answers", async () => {
    const limits = { ...DEFAULT_INGRESS_LIMITS.identity };
    const identity = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
    const counts = { global: 0, ip: 0, principal: 0, session: 0 };
    const gate = (over: { counts?: Partial<typeof counts>; hasProfile?: (principalId: string) => boolean } = {}) => {
      const limiter = new IdentityLimiter(limits, () => 0);
      const c = { ...counts, ...(over.counts ?? {}) };
      return {
        mode: "production" as const,
        wsPath: "/gs",
        allowedOrigins: new Set([PROD_ORIGIN]),
        allowedOriginList: [PROD_ORIGIN],
        trustedProxyHops: 0,
        identity,
        devAuthenticator: null,
        limiter,
        limits,
        counts: { global: () => c.global, forIp: () => c.ip, forPrincipal: () => c.principal, forAggregate: () => 0, forSession: () => c.session },
        now: () => 0,
        hasProfile: over.hasProfile ?? ((principalId: string) => identity.isProfiled(principalId)),
      };
    };
    const req = (url: string, headers: Record<string, string>, remoteAddress = "203.0.113.1") => ({ url, headers, socket: { remoteAddress } as never });
    const status = (decision: ReturnType<typeof decideUpgrade>) => (decision.ok ? 101 : `${decision.step}:${decision.status}`);
    // Everything wrong at once: the path answers.
    assert.equal(status(decideUpgrade(req("/nope", { origin: "https://evil.example" }), gate({ counts: { global: 5000, ip: 500 } }))), "path:404");
    // Path right, capacity full, origin wrong: capacity answers.
    assert.equal(status(decideUpgrade(req("/gs", { origin: "https://evil.example" }), gate({ counts: { global: 5000 } }))), "capacity:503");
    // Capacity fine, the IP at its socket cap, origin wrong: the IP answers.
    assert.equal(status(decideUpgrade(req("/gs", { origin: "https://evil.example" }), gate({ counts: { ip: 64 } }))), "ip:429");
    // An unreadable client address (hops 0, no peer): the IP step answers 400.
    assert.equal(status(decideUpgrade(req("/gs", { origin: PROD_ORIGIN }, ""), gate())), "ip:400");
    // IP fine, origin wrong, no cookie: the Origin answers.
    assert.equal(status(decideUpgrade(req("/gs", { origin: "https://evil.example" }), gate())), "origin:403");
    // Origin fine, no cookie: authentication answers.
    assert.equal(status(decideUpgrade(req("/gs", { origin: PROD_ORIGIN }), gate())), "authenticate:401");
    const created = await identity.bootstrap({ kind: "none" }, false, 0);
    let cookie = (created.kind === "ok" ? created.setCookie ?? "" : "").split(";")[0];
    // P3-ACCT: authenticated but unprofiled -- no profile step any more: the caps answer (here, full).
    assert.equal(status(decideUpgrade(req("/gs", { origin: PROD_ORIGIN, cookie }), gate({ counts: { principal: 99, session: 99 } }))), "principal-cap:429");
    // The provisional cap (6) bounds a signed-out visitor's public sockets (and a never-activated principal's).
    assert.equal(status(decideUpgrade(req("/gs", { origin: PROD_ORIGIN, cookie }), gate({ counts: { principal: 6 } }))), "principal-cap:429");
    assert.equal(status(decideUpgrade(req("/gs", { origin: PROD_ORIGIN, cookie }), gate({ counts: { principal: 6 }, hasProfile: () => true }))), "principal-cap:429");
    assert.equal(decideUpgrade(req("/gs", { origin: PROD_ORIGIN, cookie }), gate({ counts: { principal: 5 }, hasProfile: () => true })).ok, true);
    // Profiled (which makes the principal durable): the principal's cap is 24, across every device. PHASE 3 FINAL: the
    // account (username, password, Authorization Wallet) signs this browser in on a FRESH cookie.
    const account = await createAccountWith(identity, readSessionCookie(cookie), { username: "ann", password: "correct horse battery", displayName: "Ann", wallet: keplrAccount("live2b/ann") }, 0);
    assert.equal(account.kind, "ok");
    cookie = (account.kind === "ok" ? account.setCookie : "").split(";")[0];
    assert.equal(status(decideUpgrade(req("/gs", { origin: PROD_ORIGIN, cookie }), gate({ counts: { principal: 24 } }))), "principal-cap:429");
    // LIVE-2E: the SESSION (one browser, all its tabs) has its own cap, checked first.
    assert.equal(status(decideUpgrade(req("/gs", { origin: PROD_ORIGIN, cookie }), gate({ counts: { session: 12 } }))), "principal-cap:429");
    const accepted = decideUpgrade(req("/gs", { origin: PROD_ORIGIN, cookie }), gate({ counts: { principal: 23, session: 11 } }));
    assert.ok(accepted.ok);
    assert.ok(accepted.ok && Object.isFrozen(accepted.ctx), "the context is frozen");
    assert.deepEqual(accepted.ok ? Object.keys(accepted.ctx).sort() : [], ["ipKey", "openedAt", "principalId", "sessionExpiresAt", "sessionId"]);
  });

  test("global, IP, session, principal (and no provisional) socket caps; 503/429 carry Retry-After", async () => {
    const { server, port } = await prodServer({
      limits: { maxSocketsGlobal: 5, maxSocketsPerIp: 4, maxSocketsPerSession: 2, maxSocketsPerPrincipal: 3, maxSocketsPerProvisionalPrincipal: 2 },
    });
    try {
      // P3-ACCT: a never-profiled guest opens PUBLIC sockets up to its provisional cap (2 here) -- LIVE-2E refused it 403.
      const guest = cookieFrom(await bootstrap(port));
      const guestSockets = [await upgrade(port, { cookie: guest }), await upgrade(port, { cookie: guest })];
      assert.deepEqual(guestSockets.map((socket) => socket.status), [101, 101]);
      const guestCapped = await upgrade(port, { cookie: guest });
      assert.equal(guestCapped.status, 429, "the provisional cap bounds a signed-out visitor");
      for (const socket of guestSockets) socket.socket?.terminate();
      for (let wait = 0; server.socketCounts().total > 0 && wait < 100; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(server.socketCounts().total, 0, "the guest's sockets are gone before the caps below are counted");
      // One browser (session) holds at most its cap.
      const { cookie: first, username, password } = await profiledBrowser(port, "Ann", PROD_ORIGIN);
      const opened = [await upgrade(port, { cookie: first }), await upgrade(port, { cookie: first })];
      const sessionCapped = await upgrade(port, { cookie: first });
      assert.equal(sessionCapped.status, 429, "a browser holds at most its session cap");
      assert.ok(sessionCapped.retryAfter);
      // A second device of the SAME principal (PHASE 3 FINAL: it logs in with the username and password -- the
      // recovery key is gone) is its own session, but the principal's cap counts every device.
      const second = await loginOnFreshBrowser(port, username, password, PROD_ORIGIN);
      assert.equal(second.answer.status, 200);
      assert.ok(second.cookie);
      const device2 = second.cookie;
      opened.push(await upgrade(port, { cookie: device2 }));
      const principalCapped = await upgrade(port, { cookie: device2 });
      assert.equal(principalCapped.status, 429, "the principal holds at most its cap across devices");
      assert.equal(server.upgrades.refused["principal-cap:429"], 3, "the guest's provisional cap, the browser's and the principal's");
      // Another player at the same address: the address's cap.
      const other = await profiled(port, "Bea");
      opened.push(await upgrade(port, { cookie: other }));
      const ipCapped = await upgrade(port, { cookie: other });
      assert.equal(ipCapped.status, 429, "the address holds at most its cap");
      assert.equal(server.upgrades.refused["ip:429"], 1);
      for (const each of opened) assert.equal(each.status, 101);
      for (const each of opened) each.socket?.terminate();
      await until(() => server.socketCounts().total === 0, "the sockets to go");
    } finally {
      await stopServer(server);
    }
    const tight = await prodServer({ limits: { maxSocketsGlobal: 1 } });
    try {
      const cookie = await profiled(tight.port);
      const one = await upgrade(tight.port, { cookie });
      const two = await upgrade(tight.port, { cookie });
      assert.equal(one.status, 101);
      assert.equal(two.status, 503);
      assert.equal(two.retryAfter, "5");
      one.socket?.terminate();
    } finally {
      await stopServer(tight.server);
    }
  });

  test("a socket's identity is frozen: no frame can change it (a `claim` is bad-frame; another seat's move is never its own)", async () => {
    const { server, port } = await startServer({ store: controlledStore().store });
    try {
      /* LIVE-2D: the legacy `room`-keyed frames and `room-write` are unknown to the schema; a `claim` on the new ones too. */
      const { gameId, playerIds } = await openGame(port, BOB, [ALICE], { start: false });
      const alice = await Client.open(port, ALICE);
      alice.send({ kind: "hello", gameId, build: BUILD, claim: BOB, baseIndex: -1 });
      assert.equal((await alice.next((f) => f.kind === "error", "bad-frame")).code, "bad-frame");
      alice.send({ kind: "room-hello", gameId, build: BUILD, claim: BOB });
      assert.equal((await alice.next((f) => f.kind === "error", "bad-frame")).code, "bad-frame");
      alice.send({ kind: "room-write", room: "JUNO-ID", write: { op: "host", hostId: BOB, nickname: "Bob", variants: {} } });
      assert.equal((await alice.next((f) => f.kind === "error", "bad-frame")).code, "bad-frame");
      // Bob's host seat is his: a start, a kick or a transfer from Alice's socket is hers, and refused as hers.
      alice.roomHello(gameId);
      await alice.next((f) => f.kind === "room", "Alice's own view");
      for (const body of [{ type: "start-game" }, { type: "kick", playerId: playerIds[BOB] }, { type: "transfer-host", toPlayerId: playerIds[ALICE] }]) {
        assert.equal((await alice.op(body, gameId)).code, "forbidden", body.type);
      }
      const view = alice.of("room").slice(-1)[0].view as { you: { role: string; playerId: string } };
      assert.deepEqual([view.you.role, view.you.playerId], ["player", playerIds[ALICE]], "the view is of her own seat");
      assert.equal(server.socketCounts().byPrincipal(`pr_dev_${ALICE}`), 1);
      await until(() => server.socketCounts().byPrincipal(`pr_dev_${BOB}`) === 0, "Bob's table sockets gone");
    } finally {
      await stopServer(server);
    }
  });

  test("LIVE-2D: legacy room frames are refused in production AND development -- unknown kinds, before any room is read", async () => {
    /* LIVE-2B answered `no-seat-identity` here, from a registered legacy handler; LIVE-2C refused them in production
       only. LIVE-2D deleted the handlers: both modes answer every legacy frame `bad-frame`, and no socket reads a game
       by a legacy code. */
    assert.deepEqual([...LEGACY_ROOM_HANDLERS], []);
    const legacy = [
      { kind: "room-hello", room: "JUNO-ABC", build: BUILD },
      { kind: "hello", room: "JUNO-ABC", build: BUILD, baseIndex: -1 },
      { kind: "lobby-hello" },
      { kind: "room-write", room: "JUNO-ABC", write: { op: "host", hostId: ALICE, nickname: "A", variants: {} } },
    ];
    const prod = await prodServer();
    try {
      const cookie = await profiled(prod.port);
      const socket = await upgrade(prod.port, { cookie });
      assert.equal(socket.status, 101);
      for (const frame of legacy) socket.socket?.send(JSON.stringify(frame));
      await until(() => socket.frames.filter((frame) => frame.code === "bad-frame").length === legacy.length, "every legacy frame refused");
      assert.equal(socket.frames.filter((frame) => frame.code === "no-seat-identity").length, 0);
      assert.equal(prod.server.socketCounts().byGame("JUNO-ABC"), 0);
      socket.socket?.terminate();
    } finally {
      await stopServer(prod.server);
    }
    const dev = await startServer({ store: controlledStore().store });
    try {
      const alice = await Client.open(dev.port, ALICE);
      for (const frame of legacy) alice.send(frame);
      await until(() => alice.of("error").filter((frame) => frame.code === "bad-frame").length === legacy.length, "every legacy frame refused");
      assert.equal(dev.server.socketCounts().byGame("JUNO-ABC"), 0);
      assert.equal(dev.server.residentGames(), 0, "no game was loaded for a legacy code");
      // Nor does a well-formed game id that names nothing allocate anything.
      alice.hello(mintGameId());
      assert.equal((await alice.next((f) => f.kind === "error" && f.code !== "bad-frame", "the unknown game")).code, "not-found");
      assert.equal(dev.server.residentGames(), 0);
    } finally {
      await stopServer(dev.server);
    }
  });

  test("an expired session's socket closes 4401 at its next frame; the sweep closes an idle one", async () => {
    const clock = { now: 1_750_000_000_000 };
    const { server, port } = await prodServer({ clock, limits: { sweepIntervalMs: 50 } });
    try {
      const cookie = await profiled(port);
      const active = await upgrade(port, { cookie });
      const idle = await upgrade(port, { cookie });
      clock.now += 30 * DAY;
      active.socket?.send(JSON.stringify({ kind: "lobby-hello" }));
      assert.equal(await active.closed, 4401);
      assert.equal(await idle.closed, 4401);
    } finally {
      await stopServer(server);
    }
  });
});

describe("LIVE-2B limits", () => {
  test("failed upgrades: after the burst the address is refused 429 before its Origin is even read", async () => {
    const { server, port } = await prodServer({ limits: { failedUpgradesPerIp: { capacity: 3, refillPerSecond: 0.001 } } });
    try {
      for (let n = 0; n < 3; n += 1) assert.equal((await upgrade(port, {})).status, 401);
      const limited = await upgrade(port, {});
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.retryAfter) >= 1);
      assert.equal(server.upgrades.refused["ip:429"], 1);
    } finally {
      await stopServer(server);
    }
  });

  test("every upgrade: per address (429) and for the whole server (503)", async () => {
    const perIp = await prodServer({ limits: { upgradesPerIp: { capacity: 2, refillPerSecond: 0.001 } } });
    try {
      const cookie = await profiled(perIp.port);
      const a = await upgrade(perIp.port, { cookie });
      const b = await upgrade(perIp.port, { cookie });
      assert.equal((await upgrade(perIp.port, { cookie })).status, 429);
      a.socket?.terminate();
      b.socket?.terminate();
    } finally {
      await stopServer(perIp.server);
    }
    const global = await prodServer({ limits: { upgradesGlobal: { capacity: 1, refillPerSecond: 0.001 } } });
    try {
      const cookie = await profiled(global.port);
      const a = await upgrade(global.port, { cookie });
      assert.equal((await upgrade(global.port, { cookie })).status, 503);
      a.socket?.terminate();
    } finally {
      await stopServer(global.server);
    }
  });

  test("principal-creating bootstrap: per address and global budgets (429); existing sessions have their own", async () => {
    const { server, port } = await prodServer({
      limits: { guestCreatesPerIp: { capacity: 2, refillPerSecond: 0.0001 }, bootstrapsPerSession: { capacity: 2, refillPerSecond: 0.0001 } },
    });
    try {
      const cookie = cookieFrom(await bootstrap(port));
      assert.equal((await bootstrap(port)).status, 201);
      const limited = await bootstrap(port);
      assert.equal(limited.status, 429);
      assert.equal(JSON.parse(limited.body).error, "rate-limited");
      assert.equal(server.identity.sizes().principals, 2, "no principal for a refused bootstrap");
      assert.equal((await bootstrap(port, cookie)).status, 200);
      assert.equal((await bootstrap(port, cookie)).status, 200);
      assert.equal((await bootstrap(port, cookie)).status, 429, "60 a minute per session (2 here)");
    } finally {
      await stopServer(server);
    }
    const global = await prodServer({ limits: { guestCreatesGlobal: { capacity: 1, refillPerSecond: 0.0001 } } });
    try {
      assert.equal((await bootstrap(global.port)).status, 201);
      assert.equal((await bootstrap(global.port)).status, 429);
    } finally {
      await stopServer(global.server);
    }
  });

  test("malformed-flood cooldown: three 1008 closes from one address in ten minutes refuse its upgrades 429", async () => {
    const { server, port } = await startServer({ store: controlledStore().store, limits: { identity: { failedUpgradesPerIp: { capacity: 1e6, refillPerSecond: 1e6 } } } });
    try {
      for (let round = 0; round < 3; round += 1) {
        const client = await Client.open(port, ALICE);
        const closed = new Promise<number>((resolve) => client.socket.once("close", (code) => resolve(code)));
        for (let n = 0; n < 11; n += 1) client.socket.send("not json");
        assert.equal(await closed, 1008);
      }
      assert.equal(server.upgrades.malformedCooldowns, 1);
      const refused = await new Promise<{ status: number; retryAfter?: string }>((resolve) => {
        const socket = new WebSocket(devSocketUrl(port, BOB), { origin: DEV_ORIGIN });
        socket.on("error", () => undefined);
        socket.once("open", () => resolve({ status: 101 }));
        socket.once("unexpected-response", (req, res) => {
          resolve({ status: res.statusCode ?? 0, retryAfter: res.headers["retry-after"] as string | undefined });
          res.resume();
          req.destroy();
        });
      });
      assert.equal(refused.status, 429);
      assert.ok(Number(refused.retryAfter) > 200, "about five minutes");
    } finally {
      await stopServer(server);
    }
  });
});

describe("LIVE-2B development mode", () => {
  test("development accepts a loopback dev claim at / and /gs; a forwarded or remote-looking upgrade is 403; no claim is 401", async () => {
    const { server, port } = await startServer({ store: controlledStore().store });
    try {
      const direct = await upgrade(port, { path: "/?dev_claim=p-alice", origin: DEV_ORIGIN });
      const gs = await upgrade(port, { path: "/gs?dev_claim=p-alice", origin: DEV_ORIGIN });
      assert.equal(direct.status, 101);
      assert.equal(gs.status, 101);
      assert.equal(server.socketCounts().byPrincipal("pr_dev_p-alice"), 2);
      assert.equal((await upgrade(port, { path: "/?dev_claim=p-alice", origin: DEV_ORIGIN, headers: { "X-Forwarded-For": "203.0.113.9" } })).status, 403);
      assert.equal((await upgrade(port, { path: "/?dev_claim=p-alice", origin: DEV_ORIGIN, headers: { "X-Real-IP": "127.0.0.1" } })).status, 403);
      assert.equal((await upgrade(port, { path: "/?dev_claim=p-alice", origin: DEV_ORIGIN, headers: { Forwarded: "for=127.0.0.1" } })).status, 403);
      assert.equal((await upgrade(port, { path: "/?dev_claim=p-alice", origin: DEV_ORIGIN, headers: { "X-Forwarded-Host": "localhost" } })).status, 403);
      assert.equal((await upgrade(port, { path: "/?dev_claim=p-alice", origin: DEV_ORIGIN, headers: { Host: "abc.ngrok.app" } })).status, 403, "a tunnel's Host");
      assert.equal((await upgrade(port, { path: "/?dev_claim=p-alice", origin: "https://abc.ngrok.app" })).status, 403, "a tunnel's Origin");
      assert.equal((await upgrade(port, { path: "/", origin: DEV_ORIGIN })).status, 401);
      direct.socket?.terminate();
      gs.socket?.terminate();
    } finally {
      await stopServer(server);
    }
  });

  test("a development authenticator cannot be handed to a production server, nor built outside development", async () => {
    const identity = devIdentity();
    await assert.rejects(
      startServer({ identity: { ...identity, mode: "production", allowedOrigins: [PROD_ORIGIN] } }),
      /refuses a development authenticator/,
    );
    await assert.rejects(startServer({ identity: { ...identity, trustedProxyHops: 1 } }), /refuses trusted proxy hops/);
    await assert.rejects(startServer({ identity: { ...identity, allowedOrigins: ["https://abc.ngrok.app"] } }), /loopback allowed origins/);
    await assert.rejects(
      startServer({ identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0 }, explainDivergence: true }),
      /refuses explainDivergence/,
    );
  });

  test("the ordinary local development flow: host -> join -> ready -> start -> play -> undo -> close, then back", async () => {
    /* LIVE-2D: on the server-owned protocol -- the only one -- under the development authenticator. */
    const control = controlledStore();
    const { server, port } = await startServer({ store: control.store });
    try {
      const hostDoc = await Client.open(port, ALICE);
      const created = await hostDoc.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "Alice" });
      assert.equal(created.ok, true, JSON.stringify(created));
      const { gameId, code, playerId: alicePlayer } = created.data as { gameId: string; code: string; playerId: string };
      hostDoc.roomHello(gameId);
      await hostDoc.next((f) => f.kind === "room", "the hosted room");
      const joinDoc = await Client.open(port, BOB);
      const joined = await joinDoc.op({ type: "join", code, takeSeat: true });
      assert.equal(joined.ok, true, JSON.stringify(joined));
      joinDoc.roomHello(gameId);
      await hostDoc.next((f) => f.kind === "room" && ((f.view as { players?: unknown[] }).players?.length ?? 0) === 2, "Bob seated");
      for (const who of [hostDoc, joinDoc]) assert.equal((await who.op({ type: "set-ready", ready: true }, gameId)).ok, true);
      await hostDoc.next((f) => f.kind === "room" && (f.view as { you: { canStart: boolean } }).you.canStart, "both ready");
      const alice = await Client.open(port, ALICE);
      const bob = await Client.open(port, BOB);
      alice.hello(gameId);
      bob.hello(gameId);
      await alice.next((f) => f.kind === "catch-up", "alice's catch-up");
      await bob.next((f) => f.kind === "catch-up", "bob's catch-up");
      assert.equal((await hostDoc.op({ type: "start-game" }, gameId)).ok, true, "the server deals");
      await hostDoc.next((f) => f.kind === "room" && (f.view as { status?: string }).status === "playing", "the room playing");
      await alice.next((f) => f.kind === "applied", "the deal");
      alice.submit(BUY, { baseIndex: 0, submissionId: "dev-buy" }); // host first: the deal in seat order
      const bought = await alice.answerTo("dev-buy");
      assert.equal(bought.kind, "applied");
      const boughtIndex = (bought.entries as Array<{ index: number; actor: string }>).find((entry) => entry.actor === alicePlayer)?.index ?? -1;
      assert.ok(boughtIndex > 0);
      const at = Math.max(...control.log(gameId).map((entry) => entry.index));
      alice.submit({ RevertTo: { index: boughtIndex, player: alicePlayer, summary: "undo" } }, { baseIndex: at, submissionId: "dev-undo" });
      assert.equal((await alice.answerTo("dev-undo")).kind, "applied", "one-step undo of her own move");
      assert.equal(server.socketCounts().byGame(gameId), 4);
      for (const client of [alice, bob, hostDoc, joinDoc]) await client.close();
      await until(() => server.socketCounts().total === 0, "every socket closed");
      // And back: a reconnecting player is caught up from the durable log.
      const again = await Client.open(port, BOB);
      again.hello(gameId);
      const catchUp = await again.next((f) => f.kind === "catch-up", "the catch-up");
      assert.equal((catchUp.entries as unknown[]).length, control.log(gameId).length);
      await again.close();
    } finally {
      await stopServer(server);
    }
  });
});

describe("LIVE-2B startup (spawned processes)", () => {
  const start = path.join(__dirname, "..", "start.js");
  const run = (args: string[], env: Record<string, string | undefined>) => {
    const clean: NodeJS.ProcessEnv = { ...process.env };
    for (const name of ["GS_MODE", "GS_ALLOWED_ORIGINS", "GS_TRUSTED_PROXY_HOPS", "INSECURE_LOCAL_IDENTITY", "LEGACY_LOGS", "EXPLAIN_DIVERGENCE"]) delete clean[name];
    for (const [name, value] of Object.entries(env)) if (value !== undefined) clean[name] = value;
    const child = spawn(process.execPath, [start, "--port", "0", ...args], { env: clean, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (out += String(chunk)));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    return { child, output: () => out, exited };
  };
  const PROD = { GS_MODE: "production", GS_ALLOWED_ORIGINS: PROD_ORIGIN, GS_TRUSTED_PROXY_HOPS: "1" };

  test("no mode, and every insecure production setting, exit 2 with a named reason -- and (LIVE-2D) a clean production config starts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live2b-start-"));
    try {
      const cases: Array<[string[], Record<string, string | undefined>, RegExp]> = [
        [[], {}, /GS_MODE is not set/],
        [[], { GS_MODE: "staging" }, /must be "development" or "production"/],
        [["--insecure-local-identity"], PROD, /--insecure-local-identity/],
        [[], { ...PROD, INSECURE_LOCAL_IDENTITY: "1" }, /INSECURE_LOCAL_IDENTITY/],
        [[], { ...PROD, LEGACY_LOGS: "development-corpus" }, /legacy-logs/],
        [["--explain-divergence"], PROD, /explain-divergence/],
        [[], { ...PROD, GS_ALLOWED_ORIGINS: "" }, /GS_ALLOWED_ORIGINS/],
        [[], { ...PROD, GS_ALLOWED_ORIGINS: "http://play.example" }, /non-https/],
        [[], { ...PROD, GS_TRUSTED_PROXY_HOPS: undefined }, /GS_TRUSTED_PROXY_HOPS/],
        [[], { GS_MODE: "development", GS_TRUSTED_PROXY_HOPS: "1" }, /loopback-only/],
        [[], { GS_MODE: "development", GS_ALLOWED_ORIGINS: "https://abc.ngrok.app" }, /non-loopback/],
      ];
      await Promise.all(
        cases.map(async ([args, env, reason]) => {
          const child = run([...args, "--data", path.join(dir, String(Math.random()).slice(2))], env);
          assert.equal(await child.exited, 2, child.output());
          assert.match(child.output(), reason);
          assert.match(child.output(), /Refusing to start/);
        }),
      );
      /* LIVE-2D: the legacy room protocol is gone, so a clean, secure production config STARTS (LIVE-2C refused it with
         exit 2 while the build still carried the legacy handlers). Every refusal above is unchanged. */
      const prod = run(["--data", path.join(dir, "ok")], PROD);
      const prodDeadline = Date.now() + 20_000;
      while (!/GS_MODE=production/.test(prod.output()) && prod.child.exitCode === null && Date.now() < prodDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(prod.child.exitCode, null, `production started and is running: ${prod.output()}`);
      assert.doesNotMatch(prod.output(), /Refusing to start/);
      assert.match(prod.output(), /PRODUCTION IDENTITY: the __Host-gs_session cookie \(Secure; HttpOnly; SameSite=Strict\)/);
      assert.match(prod.output(), /trusted proxy hops 1/);
      assert.match(prod.output(), new RegExp(`allowed origins: ${PROD_ORIGIN.replace(/[.]/g, "\\.")}`));
      assert.doesNotMatch(prod.output(), /DEVELOPMENT IDENTITY|dev_claim/, "no development authenticator in production");
      assert.ok(fs.existsSync(path.join(dir, "ok")), "it took its data directory");
      prod.child.kill("SIGTERM");
      await prod.exited;
      const dev = run(["--data", path.join(dir, "dev")], { GS_MODE: "development" });
      const devDeadline = Date.now() + 20_000;
      while (!/GS_MODE=development/.test(dev.output()) && Date.now() < devDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.match(dev.output(), /NEVER point a tunnel at this server/);
      dev.child.kill("SIGTERM");
      await dev.exited;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LIVE-2B nothing secret reaches a log line", () => {
  test("a full cookie lifecycle, with failures, prints no cookie, secret or hash", async () => {
    const lines: string[] = [];
    const saved = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...args: unknown[]) => lines.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(" "));
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    const store = createMemoryIdentityStore();
    const service = IdentityService.fromSnapshot(store, { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
    const { server, port, clock } = await prodServer({ service });
    const secrets: string[] = [];
    try {
      const temporary = cookieFrom(await bootstrap(port));
      secrets.push(temporary, temporary.split(".")[2]);
      const session = service.peekSession(sessionIdOf(temporary));
      if (session) secrets.push(session.secret_hash);
      // PHASE 3 FINAL: the account's creation -- one refused by the store first (the same signed proof is sent again) --
      // its password and its password hash, and the fresh cookie it signs this browser in on. (No recovery key exists.)
      const password = "a password nobody logs";
      secrets.push(password);
      const proof = await createAuthorization(port, temporary, "ann-logs", keplrAccount("live2b/logs-ann"), PROD_ORIGIN);
      const body = JSON.stringify({ username: "ann-logs", password, name: "Ann", ...proof });
      store.failNext.push("definite");
      assert.equal((await request(port, "/gs/api/account/create", { cookie: temporary, body })).status, 503);
      const created = await request(port, "/gs/api/account/create", { cookie: temporary, body });
      assert.equal(created.status, 201);
      const cookie = cookieFrom(created);
      secrets.push(cookie, cookie.split(".")[2]);
      const hash = service.peekProfileOf(service.peekSession(sessionIdOf(cookie))?.principal_id ?? "")?.password_hash;
      assert.ok(hash);
      secrets.push(hash, hash.split("$").slice(-2).join("$"));
      await upgrade(port, { cookie: `${cookie}x` });
      await upgrade(port, { cookie, origin: "https://evil.example" });
      const socket = await upgrade(port, { cookie });
      socket.socket?.send("not json");
      clock.now += 8 * DAY;
      store.failNext.push("definite");
      await bootstrap(port, cookie);
      const rotated = cookieFrom(await bootstrap(port, cookie));
      secrets.push(rotated, rotated.split(".")[2]);
      await request(port, "/gs/api/session/revoke", { cookie: rotated });
      socket.socket?.terminate();
    } finally {
      console.log = saved.log;
      console.warn = saved.warn;
      console.error = saved.error;
      await stopServer(server);
    }
    const printed = lines.join("\n");
    for (const secret of secrets) assert.ok(!printed.includes(secret), "a secret reached the window");
  });
});

describe("LIVE-2B adversarial-review regressions", () => {
  const limitsWith = (over: Partial<IdentityLimits>) => ({ ...DEFAULT_INGRESS_LIMITS.identity, ...over });
  function gateFor(identity: IdentityService, limits: ReturnType<typeof limitsWith>, counts: { principal?: number; aggregate?: number } = {}) {
    return {
      mode: "production" as const,
      wsPath: "/gs",
      allowedOrigins: new Set([PROD_ORIGIN]),
      allowedOriginList: [PROD_ORIGIN],
      trustedProxyHops: 0,
      identity,
      devAuthenticator: null,
      limiter: new IdentityLimiter(limits, () => 0),
      limits,
      counts: { global: () => 0, forIp: () => 0, forPrincipal: () => counts.principal ?? 0, forAggregate: () => counts.aggregate ?? 0, forSession: () => 0 },
      now: () => 0,
      hasProfile: (principalId: string) => identity.isProfiled(principalId),
    };
  }
  const req = (headers: Record<string, string>, remoteAddress = "203.0.113.1") => ({ url: "/gs", headers, socket: { remoteAddress } as never });
  const verdict = (decision: ReturnType<typeof decideUpgrade>) => (decision.ok ? 101 : `${decision.step}:${decision.status}`);
  async function guestCookie(identity: IdentityService, now = 0): Promise<string> {
    const created = await identity.bootstrap({ kind: "none" }, false, now);
    return (created.kind === "ok" ? created.setCookie ?? "" : "").split(";")[0];
  }
  /** LIVE-2E: a guest that has created its profile -- the only kind of principal a gate lets through. PHASE 3 FINAL: an
   *  account (username, password, Authorization Wallet); the create's FRESH cookie is the player's. */
  let players = 0;
  async function playerCookie(identity: IdentityService, now = 0): Promise<string> {
    const cookie = await guestCookie(identity, now);
    players += 1;
    const made = await createAccountWith(identity, readSessionCookie(cookie), { username: `player${players}`, password: "correct horse battery", displayName: "Player", wallet: keplrAccount(`live2b/player${players}`) }, now);
    assert.equal(made.kind, "ok");
    return (made.kind === "ok" ? made.setCookie : "").split(";")[0];
  }

  test("High: one address refused by its own limits cannot drain the server's 50/s budget", async () => {
    const identity = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
    const gate = gateFor(identity, limitsWith({ upgradesGlobal: { capacity: 3, refillPerSecond: 0.0001 }, failedUpgradesPerIp: { capacity: 2, refillPerSecond: 0.0001 } }));
    const attacker = (n: number) => verdict(decideUpgrade(req({ origin: "https://evil.example" }), gate));
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(attacker), ["origin:403", "origin:403", "ip:429", "ip:429", "ip:429", "ip:429"]);
    const cookie = await playerCookie(identity);
    assert.equal(verdict(decideUpgrade(req({ origin: PROD_ORIGIN, cookie }, "198.51.100.2"), gate)), 101, "another address is served");
  });

  test("Medium: a principal at its socket cap does not spend its address's failed-upgrade budget (NAT neighbours)", async () => {
    const identity = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
    const limits = limitsWith({ failedUpgradesPerIp: { capacity: 1, refillPerSecond: 0.0001 } });
    const capped = gateFor(identity, limits, { principal: limits.maxSocketsPerPrincipal });
    const a = await playerCookie(identity);
    for (let n = 0; n < 5; n += 1) assert.equal(verdict(decideUpgrade(req({ origin: PROD_ORIGIN, cookie: a }), capped)), "principal-cap:429");
    const b = await playerCookie(identity);
    const neighbour = { ...capped, counts: { ...capped.counts, forPrincipal: () => 0 } };
    assert.equal(verdict(decideUpgrade(req({ origin: PROD_ORIGIN, cookie: b }), neighbour)), 101);
    /* P3-ACCT: an unprofiled browser is no longer refused (a public, read-only socket), so it spends nothing of the
       address's failed-upgrade budget either (LIVE-2E review I3 charged its 403). */
    const unprofiled = await guestCookie(identity);
    assert.equal(verdict(decideUpgrade(req({ origin: PROD_ORIGIN, cookie: unprofiled }), neighbour)), 101);
    assert.equal(verdict(decideUpgrade(req({ origin: PROD_ORIGIN, cookie: unprofiled }), neighbour)), 101, "nothing was charged");
  });

  test("Low/Medium: an IPv6 /48 holds at most ten addresses' worth of sockets", async () => {
    const identity = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
    const cookie = await playerCookie(identity);
    const full = gateFor(identity, limitsWith({}), { aggregate: 640 });
    assert.equal(verdict(decideUpgrade(req({ origin: PROD_ORIGIN, cookie }, "2001:db8:1:2::5"), full)), "ip:429");
    assert.equal(verdict(decideUpgrade(req({ origin: PROD_ORIGIN, cookie }, "203.0.113.7"), full)), 101, "IPv4 has no aggregate");
  });

  test("Medium: concurrent bootstraps with a week-old cookie mint one rotation and only the grace budget's successors", async () => {
    const store = createMemoryIdentityStore();
    const identity = IdentityService.fromSnapshot(store, { principals: [], sessions: [] });
    const cookie = await guestCookie(identity);
    const read = { kind: "session" as const, sessionId: cookie.split("=")[1].split(".")[1], secret: cookie.split(".")[2] };
    let granted = 0;
    const budget = () => (granted < 3 ? ((granted += 1), 0) : 60_000);
    const at = 8 * DAY;
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => identity.bootstrap(read, false, at, { graceBudget: budget })));
    assert.equal(outcomes.filter((o) => o.kind === "ok").length, 4, "the rotation and three grace successors");
    assert.equal(outcomes.filter((o) => o.kind === "rate-limited").length, 6);
    assert.equal(identity.stats.graceRotations, 3);
  });

  test("Medium: a logout also ends the rotated predecessor still in its grace -- no resurrection through the older cookie", async () => {
    const ended: string[][] = [];
    const identity = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { hooks: { onSessionsEnded: (ids) => ended.push([...ids]) } });
    const s0 = await guestCookie(identity);
    const r0 = { kind: "session" as const, sessionId: s0.split("=")[1].split(".")[1], secret: s0.split(".")[2] };
    const rotated = await identity.bootstrap(r0, false, 8 * DAY);
    const s1 = (rotated.kind === "ok" ? rotated.setCookie ?? "" : "").split(";")[0];
    const s1Id = s1.split("=")[1].split(".")[1];
    await identity.revoke(s1Id, "logout", 8 * DAY + 1);
    assert.deepEqual(ended, [[s1Id, r0.sessionId]], "both sessions' sockets are closed");
    assert.deepEqual(await identity.bootstrap(r0, false, 8 * DAY + 2), { kind: "ended", reason: "logout" });
  });
});
