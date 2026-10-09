// server/src/ludum/ingress.test.ts
//
// LUDUM v1 (Lane A): the `/gs/api/ludum/v1/*` ingress against docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md §2.1, §5 and every
// §10.3 security assertion -- over real HTTP, through `createGameServer` (so the dispatch order and every neighbouring
// route are the real ones).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "http";

import type { MoneyTables } from "../escrow/moneyTables";
import { TEST_PASSWORD_KDF } from "../escrow/escrow4Support";
import { IdentityService } from "../identity/sessions";
import { createMemoryIdentityStore } from "../identity/store";
import { apiRequest, bootstrapCookie, cookieFromAnswer, loginOnFreshBrowser, PROD_ORIGIN, profiledBrowser, quietConsole, startServer, stopServer, type ApiAnswer } from "../rooms/testSupport";
import { LUDUM_PREFIX } from "./registry";

quietConsole();

const LUDUM = "https://ludum.example";
const DAY = 24 * 60 * 60 * 1000;
const SESSION = `${LUDUM_PREFIX}session`;
const ROUTES = ["session", "games", "game", "case"] as const;

/** A production server whose Ludum origin is `LUDUM` (Play is `PROD_ORIGIN`); a stepped clock; a fake money layer
 *  (enough for `/gs/api/money/*` to exist, so its own Origin rule is what answers). `authenticate` calls are counted. */
async function ludumServer() {
  const clock = { now: 1_750_000_000_000 };
  const service = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
  const reads = { authenticate: 0 };
  const authenticate = service.authenticate.bind(service);
  service.authenticate = (read, now) => {
    reads.authenticate += 1;
    return authenticate(read, now);
  };
  const fakeMoney = { routes: {} } as unknown as MoneyTables;
  const { server, port } = await startServer({
    identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], ludumOrigins: [LUDUM], trustedProxyHops: 0, now: () => clock.now, service },
    money: () => fakeMoney,
  });
  return { server, port, clock, service, reads };
}

const ludum = (port: number, route: string, options: { cookie?: string; body?: object | string; origin?: string | null; contentType?: string | null; method?: string; headers?: Record<string, string> } = {}) =>
  apiRequest(port, `${LUDUM_PREFIX}${route}`, { origin: LUDUM, ...options });

/** A raw request (repeated headers survive as written). */
function rawRequest(port: number, path: string, method: string, headers: Array<[string, string]>, body = "{}"): Promise<ApiAnswer> {
  return new Promise((resolve, reject) => {
    const flat: string[] = ["Host", `127.0.0.1:${port}`];
    for (const [name, value] of headers) flat.push(name, value);
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: flat as unknown as http.OutgoingHttpHeaders }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += String(chunk)));
      res.on("end", () => {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = text === "" ? null : (JSON.parse(text) as Record<string, unknown>);
        } catch {
          parsed = null;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(method === "OPTIONS" || body === "" ? undefined : body);
  });
}

const accessControl = (answer: ApiAnswer): string[] => Object.keys(answer.headers).filter((name) => name.startsWith("access-control-"));
const assertNoCors = (answer: ApiAnswer, label: string) => assert.deepEqual(accessControl(answer), [], `${label}: no Access-Control-* header`);
const assertNoCookie = (answer: ApiAnswer, label: string) => assert.equal(answer.headers["set-cookie"], undefined, `${label}: no Set-Cookie`);
function assertCors(answer: ApiAnswer, origin: string, label: string) {
  assert.equal(answer.headers["access-control-allow-origin"], origin, `${label}: the exact ACAO`);
  assert.equal(answer.headers["access-control-allow-credentials"], "true", `${label}: ACAC`);
  assert.match(String(answer.headers.vary), /\bOrigin\b/, `${label}: Vary: Origin`);
  assert.equal(answer.headers["cache-control"], "no-store", `${label}: no-store`);
  assert.equal(answer.headers["access-control-expose-headers"], undefined, `${label}: no Expose-Headers`);
}
const signedOut = (answer: ApiAnswer) => answer.status === 200 && answer.body?.signedIn === false;

describe("LUDUM ingress: origins (§2.1, §10.3 negative CORS)", () => {
  test("every refused Origin -- and two Origin headers -- gets 403 with no Access-Control-* header, on OPTIONS and POST", async () => {
    const { server, port, reads } = await ludumServer();
    try {
      const refused = [
        "https://evil.example",
        "null",
        "http://ludum.example",
        "https://ludum.example:8443",
        "https://ludum.example/",
        "https://ludum.example.evil.example",
        "https://evilludum.example",
        "https://LUDUM.example",
      ];
      for (const route of ROUTES) {
        for (const origin of refused) {
          for (const method of ["OPTIONS", "POST"]) {
            const answer = await rawRequest(port, `${LUDUM_PREFIX}${route}`, method, [["Origin", origin], ["Content-Type", "application/json"]]);
            assert.equal(answer.status, 403, `${method} ${route} from ${origin}`);
            assertNoCors(answer, `${method} ${route} from ${origin}`);
            assertNoCookie(answer, origin);
          }
        }
        for (const method of ["OPTIONS", "POST"]) {
          const missing = await rawRequest(port, `${LUDUM_PREFIX}${route}`, method, [["Content-Type", "application/json"]]);
          assert.equal(missing.status, 403, `${method} ${route}, no Origin`);
          assertNoCors(missing, "missing Origin");
          const twice = await rawRequest(port, `${LUDUM_PREFIX}${route}`, method, [["Origin", LUDUM], ["Origin", LUDUM], ["Content-Type", "application/json"]]);
          assert.equal(twice.status, 403, `${method} ${route}, two Origin headers`);
          assertNoCors(twice, "two Origin headers");
          const mixed = await rawRequest(port, `${LUDUM_PREFIX}${route}`, method, [["Origin", "https://evil.example"], ["Origin", LUDUM], ["Content-Type", "application/json"]]);
          assert.equal(mixed.status, 403, `${method} ${route}, an evil and a good Origin`);
          assertNoCors(mixed, "evil + good");
        }
      }
      assert.equal(reads.authenticate, 0, "a refused origin never reaches the session");
    } finally {
      await stopServer(server);
    }
  });

  test("Ludum and Play origins are both answered with their own exact origin; never `*`", async () => {
    const { server, port } = await ludumServer();
    try {
      for (const origin of [LUDUM, PROD_ORIGIN]) {
        const answer = await ludum(port, "session", { origin });
        assert.equal(answer.status, 200);
        assertCors(answer, origin, origin);
        assert.notEqual(answer.headers["access-control-allow-origin"], "*");
      }
    } finally {
      await stopServer(server);
    }
  });
});

describe("LUDUM ingress: the preflight (§2.1)", () => {
  test("an allowed preflight is 204 with exactly the §2.1 headers, reads no cookie and touches no session", async () => {
    const { server, port, reads } = await ludumServer();
    try {
      const browser = await profiledBrowser(port, "Pre", PROD_ORIGIN);
      const before = reads.authenticate;
      for (const route of ROUTES) {
        const answer = await rawRequest(port, `${LUDUM_PREFIX}${route}`, "OPTIONS", [
          ["Origin", LUDUM],
          ["Cookie", browser.cookie],
          ["Access-Control-Request-Method", "PUT"],
          ["Access-Control-Request-Headers", "x-evil"],
        ]);
        assert.equal(answer.status, 204, route);
        assert.equal(answer.text, "");
        assert.deepEqual(accessControl(answer).sort(), [
          "access-control-allow-credentials",
          "access-control-allow-headers",
          "access-control-allow-methods",
          "access-control-allow-origin",
          "access-control-max-age",
        ]);
        assert.equal(answer.headers["access-control-allow-origin"], LUDUM);
        assert.equal(answer.headers["access-control-allow-credentials"], "true");
        assert.equal(answer.headers["access-control-allow-methods"], "POST", "static: never echoes the requested method");
        assert.equal(answer.headers["access-control-allow-headers"], "Content-Type", "static: never echoes the requested headers");
        assert.equal(answer.headers["access-control-max-age"], "600");
        assert.equal(answer.headers.vary, "Origin");
        assert.equal(answer.headers["cache-control"], "no-store");
        assertNoCookie(answer, "preflight");
      }
      assert.equal(reads.authenticate, before, "no preflight reads the session");
    } finally {
      await stopServer(server);
    }
  });

  test("a preflight for an unknown route under the prefix is 404 (CORS for the allowed origin); a non-prefix path is not ours", async () => {
    const { server, port } = await ludumServer();
    try {
      const unknown = await rawRequest(port, `${LUDUM_PREFIX}nope`, "OPTIONS", [["Origin", LUDUM]]);
      assert.equal(unknown.status, 404);
      assertCors(unknown, LUDUM, "unknown route");
      const other = await rawRequest(port, "/gs/api/account/me", "OPTIONS", [["Origin", LUDUM]]);
      assertNoCors(other, "OPTIONS outside the prefix");
    } finally {
      await stopServer(server);
    }
  });
});

describe("LUDUM ingress: methods, content type and body (§5, §10.3)", () => {
  test("GET, PUT, DELETE (and others) on the prefix get 405", async () => {
    const { server, port } = await ludumServer();
    try {
      /* Raw requests with an explicit Content-Length: Node's client frames no body on DELETE by default. */
      const call = (method: string, origin: string) =>
        rawRequest(port, SESSION, method, [["Origin", origin], ["Content-Type", "application/json"], ...(method === "GET" || method === "HEAD" ? [] : [["Content-Length", "2"] as [string, string]])], method === "GET" || method === "HEAD" ? "" : "{}");
      for (const method of ["GET", "PUT", "DELETE", "PATCH", "HEAD"]) {
        const answer = await call(method, LUDUM);
        assert.equal(answer.status, 405, method);
        assertNoCookie(answer, method);
        assertCors(answer, LUDUM, method);
        const foreign = await call(method, "https://evil.example");
        assert.equal(foreign.status, 405);
        assertNoCors(foreign, `${method} from a refused origin`);
      }
    } finally {
      await stopServer(server);
    }
  });

  test("text/plain, form-urlencoded and multipart POSTs are 400 BEFORE the session is read", async () => {
    const { server, port, reads } = await ludumServer();
    try {
      const browser = await profiledBrowser(port, "Ct", PROD_ORIGIN);
      const before = reads.authenticate;
      for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", null]) {
        const answer = await ludum(port, "session", { cookie: browser.cookie, contentType, body: "{}" });
        assert.equal(answer.status, 400, String(contentType));
        assert.equal(answer.body?.error, "bad-request");
        assertCors(answer, LUDUM, String(contentType));
        assertNoCookie(answer, String(contentType));
      }
      assert.equal(reads.authenticate, before, "the session was never read");
    } finally {
      await stopServer(server);
    }
  });

  test("a body over 1 KiB, unknown keys, wrong types or not an object: 400 with the CORS headers", async () => {
    const { server, port } = await ludumServer();
    try {
      const bad: Array<[string, object | string]> = [
        ["session", { padding: "x".repeat(1100) }],
        ["session", "x".repeat(1025)],
        ["session", { extra: 1 }],
        ["games", { limit: "20" }],
        ["games", { limit: 1.5 }],
        ["games", { cursor: 5 }],
        ["games", { principalId: "pr_x" }],
        ["game", { gameId: 7 }],
        ["game", { gameId: "g_1", player: "x" }],
        ["case", { chainGameId: "1", wallet: "juno1x" }],
        ["case", "[]"],
        ["case", "not json"],
      ];
      for (const [route, body] of bad) {
        const answer = await ludum(port, route, { body });
        assert.equal(answer.status, 400, `${route} ${String(typeof body === "string" ? body.slice(0, 20) : JSON.stringify(body).slice(0, 40))}`);
        assert.equal(answer.body?.error, "bad-request");
        assertCors(answer, LUDUM, route);
      }
      /* Exactly at the limit is read. */
      const atLimit = JSON.stringify({ chainGameId: "1" }).padEnd(1024, " ");
      assert.notEqual((await ludum(port, "case", { body: atLimit })).status, 400);
    } finally {
      await stopServer(server);
    }
  });

  test("an unknown route under the prefix is 404 `not-found`, with the CORS headers", async () => {
    const { server, port } = await ludumServer();
    try {
      for (const path of ["nope", "games/", "Games", "__proto__"]) {
        const answer = await ludum(port, path);
        assert.equal(answer.status, 404, path);
        assert.equal(answer.body?.error, "not-found");
        assertCors(answer, LUDUM, path);
      }
    } finally {
      await stopServer(server);
    }
  });
});

describe("LUDUM ingress: the session (§2.1 session semantics, §10.3)", () => {
  test("a signed-in account reads `session` as §5 SessionResponse: no id, no Set-Cookie", async () => {
    const { server, port, clock } = await ludumServer();
    try {
      const browser = await profiledBrowser(port, "Ada Ludum", PROD_ORIGIN);
      const answer = await ludum(port, "session", { cookie: browser.cookie });
      assert.equal(answer.status, 200);
      assertCors(answer, LUDUM, "session");
      assertNoCookie(answer, "session");
      const body = answer.body as { signedIn: true; account: Record<string, unknown>; manageUrl: string };
      assert.equal(body.signedIn, true);
      assert.deepEqual(Object.keys(body).sort(), ["account", "manageUrl", "signedIn"]);
      assert.deepEqual(Object.keys(body.account).sort(), ["authorizationWallet", "memberSince", "name", "username"]);
      assert.equal(body.account.name, browser.name);
      assert.equal(body.account.username, browser.username);
      assert.equal(body.account.memberSince, new Date(clock.now).toISOString().slice(0, 7));
      assert.deepEqual(body.account.authorizationWallet, { address: browser.wallet.address, since: new Date(clock.now).toISOString() });
      assert.equal(body.manageUrl, `${PROD_ORIGIN}/`);
      assert.doesNotMatch(answer.text, /pr_|pf_|se_|sf_|otherSessions/);
    } finally {
      await stopServer(server);
    }
  });

  test("no cookie, an unprofiled (provisional) session, a malformed or duplicate cookie, a look-alike name: signed out", async () => {
    const { server, port } = await ludumServer();
    try {
      const browser = await profiledBrowser(port, "Dup", PROD_ORIGIN);
      const value = browser.cookie.split("=")[1];
      const unprofiled = await bootstrapCookie(port);
      const cases: Array<[string, string | undefined]> = [
        ["no cookie", undefined],
        ["an unprofiled, provisional session", unprofiled],
        ["a duplicate __Host-gs_session", `${browser.cookie}; ${browser.cookie}`],
        ["a look-alike name", `__host-gs_session=${value}`],
        ["a percent-encoded look-alike", `__Host-gs%5Fsession=${value}`],
        ["a wrong secret", `${browser.cookie.slice(0, -4)}AAAA`],
        ["garbage", "__Host-gs_session=v1.x.y"],
      ];
      for (const [label, cookie] of cases) {
        const answer = await ludum(port, "session", { cookie });
        assert.ok(signedOut(answer), `${label}: ${answer.status} ${answer.text}`);
        assert.equal(answer.body?.signInUrl, `${PROD_ORIGIN}/?ludum=signin&return=%2F`);
        assertNoCookie(answer, label);
        assertCors(answer, LUDUM, label);
        const games = await ludum(port, "games", { cookie });
        assert.equal(games.status, 401, `${label}: a profiled route`);
        assert.equal(games.body?.error, "signed-out");
        assertCors(games, LUDUM, `${label} 401`);
        assertNoCookie(games, label);
      }
      /* The bootstrap's own session is unchanged and still unprofiled: nothing was minted or rotated for it. */
      assert.ok(signedOut(await ludum(port, "session", { cookie: unprofiled })));
    } finally {
      await stopServer(server);
    }
  });

  test("a session revoked by sign-out reads `signed-out` on the very next call", async () => {
    const { server, port } = await ludumServer();
    try {
      const browser = await profiledBrowser(port, "Rev", PROD_ORIGIN);
      assert.equal((await ludum(port, "session", { cookie: browser.cookie })).body?.signedIn, true);
      assert.equal((await apiRequest(port, "/gs/api/session/revoke", { cookie: browser.cookie })).status, 204);
      const after = await ludum(port, "session", { cookie: browser.cookie });
      assert.ok(signedOut(after));
      assertNoCookie(after, "after revoke");
    } finally {
      await stopServer(server);
    }
  });

  test("a cookie from a family revoked by a password change reads signed-out; the changing browser stays signed in", async () => {
    const { server, port } = await ludumServer();
    try {
      const browser = await profiledBrowser(port, "Pw", PROD_ORIGIN);
      const other = await loginOnFreshBrowser(port, browser.username, browser.password);
      assert.ok(other.cookie);
      assert.equal((await ludum(port, "session", { cookie: other.cookie as string })).body?.signedIn, true);
      const changed = await apiRequest(port, "/gs/api/account/password", { cookie: browser.cookie, body: { currentPassword: browser.password, newPassword: "an entirely new passphrase" } });
      assert.equal(changed.status, 200, changed.text);
      const fresh = cookieFromAnswer(changed) ?? browser.cookie;
      const revoked = await ludum(port, "session", { cookie: other.cookie as string });
      assert.ok(signedOut(revoked), "the other device's family was revoked");
      assertNoCookie(revoked, "password-changed family");
      assert.equal((await ludum(port, "session", { cookie: fresh })).body?.signedIn, true);
    } finally {
      await stopServer(server);
    }
  });

  test("a rotated predecessor inside its 24 h bootstrap window is signed out here (and is never rotated or re-minted by Ludum)", async () => {
    const { server, port, clock, service } = await ludumServer();
    try {
      const browser = await profiledBrowser(port, "Rot", PROD_ORIGIN);
      clock.now += 8 * DAY;
      /* Ludum alone never rotates a week-old session. */
      const before = await ludum(port, "session", { cookie: browser.cookie });
      assert.equal(before.body?.signedIn, true);
      assertNoCookie(before, "a week-old session on Ludum");
      /* Play's bootstrap rotates it. */
      const rotated = await apiRequest(port, "/gs/api/session", { cookie: browser.cookie });
      assert.equal(rotated.body?.rotated, true);
      const successor = cookieFromAnswer(rotated) as string;
      const predecessor = await ludum(port, "session", { cookie: browser.cookie });
      assert.ok(signedOut(predecessor), "the rotated predecessor (still able to bootstrap on Play) is signed out on Ludum");
      assertNoCookie(predecessor, "rotated predecessor");
      assert.equal((await ludum(port, "session", { cookie: successor })).body?.signedIn, true);
      /* Ludum minted nothing: the predecessor can still bootstrap on Play exactly as before (its grace is untouched). */
      const sizes = service.sizes().sessions;
      await ludum(port, "session", { cookie: browser.cookie });
      assert.equal(service.sizes().sessions, sizes);
    } finally {
      await stopServer(server);
    }
  });

  test("an idle-expired session (30 days unseen) reads signed-out, with no Set-Cookie", async () => {
    const { server, port, clock } = await ludumServer();
    try {
      const browser = await profiledBrowser(port, "Idle", PROD_ORIGIN);
      clock.now += 31 * DAY;
      const answer = await ludum(port, "session", { cookie: browser.cookie });
      assert.ok(signedOut(answer));
      assertNoCookie(answer, "idle-expired");
    } finally {
      await stopServer(server);
    }
  });
});

describe("LUDUM ingress: every answer to an allowed origin carries CORS; nothing ever sets a cookie", () => {
  test("401, 404, 429 and 503 from an allowed origin carry the exact ACAO and credentials", async () => {
    const { server, port } = await ludumServer();
    try {
      const unauthorized = await ludum(port, "game", { body: { gameId: "g_x" } });
      assert.equal(unauthorized.status, 401);
      assertCors(unauthorized, LUDUM, "401");
      const notFound = await ludum(port, "nope");
      assert.equal(notFound.status, 404);
      assertCors(notFound, LUDUM, "404");
      const stub = await ludum(port, "case", { body: { chainGameId: "1" } });
      assert.equal(stub.status, 503, "the step-0 case stub");
      assertCors(stub, LUDUM, "503");
      let limited: ApiAnswer | null = null;
      for (let at = 0; at < 80 && limited === null; at += 1) {
        const answer = await ludum(port, "session");
        if (answer.status === 429) limited = answer;
      }
      assert.ok(limited, "the per-address budget answers 429");
      assert.equal(limited.body?.error, "rate-limited");
      assertCors(limited, LUDUM, "429");
      assertNoCookie(limited, "429");
    } finally {
      await stopServer(server);
    }
  });

  test("no ludum route ever answers Set-Cookie (signed in, signed out, every route)", async () => {
    const { server, port } = await ludumServer();
    try {
      const browser = await profiledBrowser(port, "Nc", PROD_ORIGIN);
      const bodies: Record<(typeof ROUTES)[number], object> = { session: {}, games: { limit: 5 }, game: { gameId: "g_1" }, case: { chainGameId: "1" } };
      for (const cookie of [undefined, browser.cookie]) {
        for (const route of ROUTES) assertNoCookie(await ludum(port, route, { cookie, body: bodies[route] }), `${route} ${cookie ? "signed in" : "signed out"}`);
      }
    } finally {
      await stopServer(server);
    }
  });
});

describe("LUDUM ingress: every other route is unchanged (§2.1, §10.3)", () => {
  test("the Ludum origin still gets 403 on /gs/api/account/* and /gs/api/money/*, and no route outside the prefix carries CORS", async () => {
    const { server, port } = await ludumServer();
    try {
      const browser = await profiledBrowser(port, "Iso", PROD_ORIGIN);
      for (const path of ["/gs/api/account/me", "/gs/api/account/login", "/gs/api/session", "/gs/api/profile/reauth", "/gs/api/money/config", "/gs/api/money/deposits"]) {
        const fromLudum = await apiRequest(port, path, { origin: LUDUM, cookie: browser.cookie });
        assert.equal(fromLudum.status, 403, `${path} from the Ludum origin`);
        assertNoCors(fromLudum, path);
        assertNoCookie(fromLudum, path);
        const fromPlay = await apiRequest(port, path, { origin: PROD_ORIGIN, cookie: browser.cookie });
        assertNoCors(fromPlay, `${path} from Play`);
      }
      for (const path of ["/gs/api/trust/facts", "/gs/api/conduct/reports", "/gs/api/ludum/v2/games", "/gs/api/ludum/v1", "/gs/healthz"]) {
        assertNoCors(await apiRequest(port, path, { origin: LUDUM }), path);
      }
    } finally {
      await stopServer(server);
    }
  });
});
