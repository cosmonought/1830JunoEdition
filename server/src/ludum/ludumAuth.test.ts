// server/src/ludum/ludumAuth.test.ts
//
// LUDUM v1.2 (docs/ludum/LUDUM_PLATFORM_ARCHITECTURE.md §15): Ludum's OWN sign-up, sign-in, sign-out, "Confirm it's you"
// and "Forgot password?" -- `/gs/api/ludum/v1/auth/*`, served by Play's own account handlers. Over real HTTP through
// `createGameServer`: ONE account database and ONE host-only session cookie, so signing in or out on either site signs
// both in or out; the exact-Origin and preflight rules hold; the budgets are Play's; nothing else of `/gs/api/*` opens.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "http";

import { TEST_PASSWORD_KDF } from "../escrow/escrow4Support";
import { IdentityService } from "../identity/sessions";
import { createMemoryIdentityStore } from "../identity/store";
import { accountBrowser, apiRequest, cookieFromAnswer, cookieRead, PROD_ORIGIN, quietConsole, startServer, stopServer, type ApiAnswer } from "../rooms/testSupport";
import { keplrAccount } from "../testSupport/authorizationWallets";
import { LUDUM_AUTH_ROUTES } from "./ingress";
import { LUDUM_PREFIX } from "./registry";

quietConsole();

const LUDUM = "https://ludum.example";
const PASSWORD = "correct horse battery";

async function ludumServer() {
  const clock = { now: 1_750_000_000_000 };
  const service = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
  const { server, port } = await startServer({
    identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], ludumOrigins: [LUDUM], trustedProxyHops: 0, now: () => clock.now, service },
  });
  return { server, port, clock, service };
}

const auth = (port: number, action: string, options: { cookie?: string; body?: object | string; origin?: string | null; contentType?: string | null; method?: string } = {}) =>
  options.method === "OPTIONS" ? preflight(port, `${LUDUM_PREFIX}auth/${action}`, options.origin === undefined ? LUDUM : options.origin) : apiRequest(port, `${LUDUM_PREFIX}auth/${action}`, { origin: LUDUM, ...options });

/** A preflight as a browser sends one: no body, no cookie. */
function preflight(port: number, path: string, origin: string | null): Promise<ApiAnswer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" };
    if (origin !== null) headers.Origin = origin;
    const req = http.request({ host: "127.0.0.1", port, path, method: "OPTIONS", headers }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += String(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body: null }));
    });
    req.on("error", reject);
    req.end();
  });
}
const ludumSession = (port: number, cookie?: string) => apiRequest(port, `${LUDUM_PREFIX}session`, { origin: LUDUM, ...(cookie ? { cookie } : {}) });

const COOKIE_SHAPE = /^__Host-gs_session=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=\d+$/;
function assertSessionCookie(answer: ApiAnswer, label: string): string {
  const set = answer.headers["set-cookie"];
  assert.ok(set !== undefined && set.length === 1, `${label}: exactly one Set-Cookie`);
  assert.match(set[0], COOKIE_SHAPE, `${label}: host-only (no Domain), Secure, HttpOnly, SameSite=Strict, Path=/`);
  assert.doesNotMatch(set[0], /domain=/i, `${label}: never a Domain`);
  return cookieFromAnswer(answer) as string;
}
function assertCors(answer: ApiAnswer, label: string) {
  assert.equal(answer.headers["access-control-allow-origin"], LUDUM, `${label}: the exact ACAO`);
  assert.equal(answer.headers["access-control-allow-credentials"], "true", `${label}: ACAC`);
  assert.match(String(answer.headers.vary), /\bOrigin\b/, `${label}: Vary: Origin`);
  assert.equal(answer.headers["cache-control"], "no-store", `${label}: no-store`);
  assert.equal(answer.headers["access-control-expose-headers"], undefined, `${label}: no Expose-Headers`);
}
const accessControl = (answer: ApiAnswer) => Object.keys(answer.headers).filter((name) => name.startsWith("access-control-"));

/** A Ludum browser's start: `auth/start` (201 + a temporary session cookie). */
async function ludumStart(port: number): Promise<string> {
  const started = await auth(port, "start");
  assert.equal(started.status, 201, `auth/start: ${started.text}`);
  assertCors(started, "auth/start");
  return assertSessionCookie(started, "auth/start");
}

/** A Ludum sign-up, exactly as the Ludum page does it: start, the CREATE text (signed by the wallet), create. */
async function ludumSignUp(port: number, username: string, name: string) {
  const wallet = keplrAccount(`ludum/${username}`);
  const before = await ludumStart(port);
  const minted = await auth(port, "authorization", { cookie: before, body: { purpose: "create", username, wallet: wallet.address } });
  assert.equal(minted.status, 200, minted.text);
  assertCors(minted, "auth/authorization");
  const text = (minted.body?.texts as Array<{ text: string }>)[0].text;
  const created = await auth(port, "create", { cookie: before, body: { username, password: PASSWORD, name, operation: minted.body?.operation, ...wallet.sign(text) } });
  return { before, wallet, text, created };
}

describe("LUDUM v1.2 auth: one account, one session, both sites (§15)", () => {
  test("sign-up on Ludum: the Authorization Wallet text names Ludum's site; a fresh host-only cookie; Play reads the same account", async () => {
    const { server, port, service } = await ludumServer();
    try {
      const { text, created, before } = await ludumSignUp(port, "ludumann", "Ludum Ann");
      assert.match(text, /ludum\.example/, "the wallet signs a text naming the site it is on");
      assert.equal(created.status, 201, created.text);
      assertCors(created, "auth/create");
      const cookie = assertSessionCookie(created, "auth/create");
      assert.notEqual(cookie, before, "the temporary session is replaced");
      /* The same cookie is Play's session: Play's own account route reads the account. */
      const me = await apiRequest(port, "/gs/api/account/me", { cookie });
      assert.equal(me.status, 200);
      assert.equal((me.body?.account as { username: string }).username, "ludumann");
      const read = await ludumSession(port, cookie);
      assert.equal(read.body?.signedIn, true);
      assert.equal((read.body?.account as { name: string }).name, "Ludum Ann");
      const who = service.authenticate(cookieRead(cookie), 1_750_000_000_000);
      assert.ok(who.kind === "ok" && service.isProfiled(who.principalId), "one account database: the principal is profiled");
    } finally {
      await stopServer(server);
    }
  });

  test("an account made on Play signs in on Ludum, and an account made on Ludum signs in on Play", async () => {
    const { server, port } = await ludumServer();
    try {
      const play = await accountBrowser(port, "playbob", PASSWORD, "Play Bob");
      const before = await ludumStart(port);
      const signedIn = await auth(port, "sign-in", { cookie: before, body: { username: "playbob", password: PASSWORD } });
      assert.equal(signedIn.status, 200, signedIn.text);
      assertCors(signedIn, "auth/sign-in");
      const cookie = assertSessionCookie(signedIn, "auth/sign-in");
      assert.equal((await ludumSession(port, cookie)).body?.signedIn, true);
      assert.notEqual(cookie, play.cookie);

      const ludumMade = await ludumSignUp(port, "ludumcat", "Ludum Cat");
      assert.equal(ludumMade.created.status, 201);
      const fresh = await apiRequest(port, "/gs/api/session", {});
      const playCookie = cookieFromAnswer(fresh) as string;
      const onPlay = await apiRequest(port, "/gs/api/account/login", { cookie: playCookie, body: { username: "ludumcat", password: PASSWORD } });
      assert.equal(onPlay.status, 200, onPlay.text);
      assert.equal(onPlay.headers["access-control-allow-origin"], undefined, "Play's own routes still carry no CORS header");
    } finally {
      await stopServer(server);
    }
  });

  test("signing out on Ludum ends the shared session for Play; signing out on Play ends it for Ludum", async () => {
    const { server, port } = await ludumServer();
    try {
      await accountBrowser(port, "dora", PASSWORD, "Dora");
      /* In on Ludum, out on Ludum: Play's bootstrap with that cookie is a KNOWN, ended session. */
      const before = await ludumStart(port);
      const cookie = assertSessionCookie(await auth(port, "sign-in", { cookie: before, body: { username: "dora", password: PASSWORD } }), "sign-in");
      const out = await auth(port, "sign-out", { cookie });
      assert.equal(out.status, 204);
      assertCors(out, "auth/sign-out");
      assert.match(String(out.headers["set-cookie"]), /^__Host-gs_session=; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=0$/, "the cookie is cleared, host-only");
      const playAfter = await apiRequest(port, "/gs/api/session", { cookie });
      assert.equal(playAfter.status, 401);
      assert.equal(playAfter.body?.error, "session-ended");
      assert.equal((await apiRequest(port, "/gs/api/account/me", { cookie })).status, 401);
      assert.equal((await ludumSession(port, cookie)).body?.signedIn, false);

      /* In on Play, out on Play: Ludum reads signed out. */
      const play = await accountBrowser(port, "dora2", PASSWORD, "Dora Two");
      assert.equal((await ludumSession(port, play.cookie)).body?.signedIn, true);
      assert.equal((await apiRequest(port, "/gs/api/session/revoke", { cookie: play.cookie })).status, 204);
      assert.equal((await ludumSession(port, play.cookie)).body?.signedIn, false);
    } finally {
      await stopServer(server);
    }
  });

  test("Confirm it's you on Ludum grants the same sensitive window Play's does; a wrong password grants nothing", async () => {
    const { server, port, service, clock } = await ludumServer();
    try {
      const account = await accountBrowser(port, "erin", PASSWORD, "Erin");
      clock.now += 10 * 60 * 1000; // past the window the account's creation itself opened
      assert.equal(service.hasSensitiveAuth(cookieRead(account.cookie), clock.now), false);
      const wrong = await auth(port, "confirm", { cookie: account.cookie, body: { password: "not the password" } });
      assert.equal(wrong.status, 403);
      assert.equal(wrong.body?.error, "invalid-credential");
      assert.equal(service.hasSensitiveAuth(cookieRead(account.cookie), clock.now), false);
      const right = await auth(port, "confirm", { cookie: account.cookie, body: { password: PASSWORD } });
      assert.equal(right.status, 200, right.text);
      assertCors(right, "auth/confirm");
      assert.equal(right.headers["set-cookie"], undefined, "a confirmation sets no cookie");
      assert.equal(service.hasSensitiveAuth(cookieRead(account.cookie), clock.now), true);
      assert.equal((await auth(port, "confirm", { body: { password: PASSWORD } })).status, 401, "no session: nothing to confirm");
    } finally {
      await stopServer(server);
    }
  });

  test("Forgot password? on Ludum: the Authorization Wallet's RECOVER proof; a wrong wallet is refused; earlier sessions end", async () => {
    const { server, port } = await ludumServer();
    try {
      const account = await accountBrowser(port, "finn", PASSWORD, "Finn");
      const recover = async (wallet = account.wallet) => {
        const before = await ludumStart(port);
        const minted = await auth(port, "authorization", { cookie: before, body: { purpose: "recover", username: "finn", wallet: wallet.address } });
        assert.equal(minted.status, 200, minted.text);
        const text = (minted.body?.texts as Array<{ text: string }>)[0].text;
        assert.match(text, /ludum\.example/);
        return auth(port, "recover", { cookie: before, body: { operation: minted.body?.operation, ...wallet.sign(text), newPassword: "a brand new passphrase" } });
      };
      const stranger = await recover(keplrAccount("not-finns-wallet"));
      assert.equal(stranger.status, 403);
      assert.equal(stranger.body?.error, "invalid-credential");
      assert.equal(stranger.headers["set-cookie"], undefined);
      const recovered = await recover();
      assert.equal(recovered.status, 200, recovered.text);
      assertCors(recovered, "auth/recover");
      assertSessionCookie(recovered, "auth/recover");
      assert.equal((await ludumSession(port, account.cookie)).body?.signedIn, false, "the earlier session ended");
      const before = await ludumStart(port);
      assert.equal((await auth(port, "sign-in", { cookie: before, body: { username: "finn", password: "a brand new passphrase" } })).status, 200);
    } finally {
      await stopServer(server);
    }
  });
  test("PHASE 4: Change password on Ludum -- Play's own handler: the current password, the policy; this browser keeps a fresh cookie, every other device is signed out, both sites see it", async () => {
    const { server, port } = await ludumServer();
    try {
      const account = await accountBrowser(port, "gail", PASSWORD, "Gail");
      const other = await ludumStart(port);
      assert.equal((await auth(port, "sign-in", { cookie: other, body: { username: "gail", password: PASSWORD } })).status, 200);
      const wrong = await auth(port, "password", { cookie: account.cookie, body: { currentPassword: "not the password", newPassword: "a brand new passphrase" } });
      assert.equal(wrong.status, 403);
      assert.equal(wrong.body?.error, "invalid-credential");
      assert.equal(wrong.headers["set-cookie"], undefined);
      const short = await auth(port, "password", { cookie: account.cookie, body: { currentPassword: PASSWORD, newPassword: "too short" } });
      assert.equal(short.status, 400, "the same password policy");
      const signedOut = await auth(port, "password", { body: { currentPassword: PASSWORD, newPassword: "a brand new passphrase" } });
      assert.notEqual(signedOut.status, 200, "signed out: nothing to change");
      const changed = await auth(port, "password", { cookie: account.cookie, body: { currentPassword: PASSWORD, newPassword: "a brand new passphrase" } });
      assert.equal(changed.status, 200, changed.text);
      assertCors(changed, "auth/password");
      const fresh = assertSessionCookie(changed, "auth/password");
      assert.equal((await ludumSession(port, fresh)).body?.signedIn, true, "this browser stays signed in (Ludum)");
      assert.equal((await apiRequest(port, "/gs/api/account/me", { cookie: fresh, body: {} })).status, 200, "and on Play: one session");
      assert.equal((await ludumSession(port, other)).body?.signedIn, false, "the other device is signed out");
      const play = await apiRequest(port, "/gs/api/session", { body: {} });
      const playCookie = cookieFromAnswer(play) as string;
      assert.equal((await apiRequest(port, "/gs/api/account/login", { cookie: playCookie, body: { username: "gail", password: PASSWORD } })).status, 403, "the old password is dead on Play too");
      const later = await ludumStart(port);
      assert.equal((await auth(port, "sign-in", { cookie: later, body: { username: "gail", password: "a brand new passphrase" } })).status, 200);
    } finally {
      await stopServer(server);
    }
  });

  test("PHASE 4: Forgot current password? on Ludum while SIGNED IN -- the Authorization Wallet's RECOVER proof for this account only; no old password, no sign-out first", async () => {
    const { server, port } = await ludumServer();
    try {
      const account = await accountBrowser(port, "ivy", PASSWORD, "Ivy");
      const someoneElse = await accountBrowser(port, "jon", PASSWORD, "Jon");
      const otherDevice = await ludumStart(port);
      assert.equal((await auth(port, "sign-in", { cookie: otherDevice, body: { username: "ivy", password: PASSWORD } })).status, 200);
      const reset = async (wallet = account.wallet, username = "ivy") => {
        const minted = await auth(port, "authorization", { cookie: account.cookie, body: { purpose: "recover", username, wallet: wallet.address } });
        if (minted.status !== 200) return minted;
        const text = (minted.body?.texts as Array<{ text: string }>)[0].text;
        assert.match(text, /ludum\.example/, "the text names Ludum as the site");
        return auth(port, "recover", { cookie: account.cookie, body: { operation: minted.body?.operation, ...wallet.sign(text), newPassword: "a brand new passphrase" } });
      };
      assert.equal((await reset(someoneElse.wallet, "jon")).status, 409, "never another account's");
      const stranger = await reset(keplrAccount("not-ivys-wallet"));
      assert.equal(stranger.status, 403);
      assert.equal(stranger.headers["set-cookie"], undefined);
      const done = await reset();
      assert.equal(done.status, 200, done.text);
      assertCors(done, "auth/recover");
      const fresh = assertSessionCookie(done, "auth/recover");
      assert.equal((await ludumSession(port, fresh)).body?.signedIn, true, "still signed in");
      assert.equal((await ludumSession(port, otherDevice)).body?.signedIn, false, "every other device is signed out");
      const later = await ludumStart(port);
      assert.equal((await auth(port, "sign-in", { cookie: later, body: { username: "ivy", password: PASSWORD } })).status, 403, "the forgotten password is dead");
      const again = await ludumStart(port);
      assert.equal((await auth(port, "sign-in", { cookie: again, body: { username: "ivy", password: "a brand new passphrase" } })).status, 200);
    } finally {
      await stopServer(server);
    }
  });
});

describe("LUDUM v1.2 auth: the protections hold (§15)", () => {
  test("a wrong or unknown username / password: ONE answer, no cookie; the session's sign-in budget then answers 429", async () => {
    const { server, port } = await ludumServer();
    try {
      await accountBrowser(port, "gail", PASSWORD, "Gail");
      const before = await ludumStart(port);
      const wrong = await auth(port, "sign-in", { cookie: before, body: { username: "gail", password: "wrong one" } });
      const unknown = await auth(port, "sign-in", { cookie: before, body: { username: "nobody-here", password: "wrong one" } });
      for (const answer of [wrong, unknown]) {
        assert.equal(answer.status, 403);
        assert.deepEqual(answer.body, { error: "invalid-credential" });
        assert.equal(answer.headers["set-cookie"], undefined);
        assertCors(answer, "refusal");
      }
      let limited: ApiAnswer | null = null;
      for (let attempt = 0; attempt < 20 && limited === null; attempt += 1) {
        const answer = await auth(port, "sign-in", { cookie: before, body: { username: "gail", password: `wrong ${attempt}` } });
        if (answer.status === 429) limited = answer;
      }
      assert.ok(limited !== null, "Play's sign-in budget applies to Ludum's sign-in");
      assert.equal(limited.body?.error, "rate-limited");
      assertCors(limited, "429");
      const right = await auth(port, "sign-in", { cookie: before, body: { username: "gail", password: PASSWORD } });
      assert.equal(right.status, 429, "a spent budget refuses before any check -- the right password too");
    } finally {
      await stopServer(server);
    }
  });

  test("a refused Origin gets 403 with no CORS and no cookie; Ludum's origin on Play's own account paths is still refused", async () => {
    const { server, port, service } = await ludumServer();
    try {
      const before = service.sizes().principals;
      for (const action of Object.keys(LUDUM_AUTH_ROUTES).map((name) => name.slice("auth/".length))) {
        for (const origin of ["https://evil.example", "https://ludum.example.evil.example", "http://ludum.example", "null"]) {
          for (const method of ["OPTIONS", "POST"]) {
            const answer = await auth(port, action, { origin, method });
            assert.equal(answer.status, 403, `${method} ${action} from ${origin}`);
            assert.deepEqual(accessControl(answer), [], `${method} ${action} from ${origin}: no Access-Control-*`);
            assert.equal(answer.headers["set-cookie"], undefined);
          }
        }
        const none = await auth(port, action, { origin: null });
        assert.equal(none.status, 403, `${action}: no Origin`);
      }
      assert.equal(service.sizes().principals, before, "a refused origin creates nothing");
      for (const path of ["/gs/api/session", "/gs/api/account/login", "/gs/api/account/create", "/gs/api/profile/reauth", "/gs/api/account/password"]) {
        const answer = await apiRequest(port, path, { origin: LUDUM });
        assert.equal(answer.status, 403, `${path} from Ludum`);
        assert.deepEqual(accessControl(answer), [], `${path}: Play's routes never answer CORS`);
      }
    } finally {
      await stopServer(server);
    }
  });

  test("only the eight actions exist: wallet replacement, sign-out-others and account/me are not under auth/* (PHASE 4: password change is)", async () => {
    const { server, port } = await ludumServer();
    try {
      const account = await accountBrowser(port, "hana", PASSWORD, "Hana");
      for (const action of ["me", "authorization-wallet/challenge", "authorization-wallet/replace", "sign-out-others", "session", "login", "Sign-In", "sign-in/", "sign-in/x"]) {
        for (const method of ["OPTIONS", "POST"]) {
          const answer = await auth(port, action, { cookie: account.cookie, method, body: {} });
          assert.equal(answer.status, 404, `${method} auth/${action}`);
          assert.equal(answer.headers["set-cookie"], undefined);
        }
      }
    } finally {
      await stopServer(server);
    }
  });

  test("the preflight is static (204, the §2.1 headers); a non-JSON or malformed request does no work and sets nothing", async () => {
    const { server, port, service } = await ludumServer();
    try {
      const preflight = await auth(port, "sign-in", { method: "OPTIONS" });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers["access-control-allow-origin"], LUDUM);
      assert.equal(preflight.headers["access-control-allow-methods"], "POST");
      assert.equal(preflight.headers["access-control-allow-headers"], "Content-Type");
      assert.equal(preflight.headers["set-cookie"], undefined);
      const principals = service.sizes().principals;
      for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", null]) {
        const answer = await auth(port, "start", { contentType, body: "{}" });
        assert.equal(answer.status, 400, `start as ${contentType}`);
        assert.equal(answer.headers["set-cookie"], undefined);
        assertCors(answer, "refused content type");
      }
      assert.equal(service.sizes().principals, principals, "a form-encoded or text/plain start creates nothing");
      const before = await ludumStart(port);
      const extra = await auth(port, "sign-in", { cookie: before, body: { username: "x", password: "y", remember: true } });
      assert.equal(extra.status, 400, "a closed body: an unknown key is refused");
      assert.equal((await auth(port, "sign-in", { body: { username: "x", password: "y" } })).status, 401, "no session yet: start first");
      /* Last: the ingress answers 405 without reading a PUT / DELETE body, and Node then closes that keep-alive socket. */
      for (const method of ["GET", "PUT", "DELETE"]) assert.equal((await auth(port, "start", { method })).status, 405, method);
    } finally {
      await stopServer(server);
    }
  });

  test("a body past Play's 4 KiB cap is refused 413 before it is read, and sets nothing", async () => {
    const { server, port, service } = await ludumServer();
    try {
      const principals = service.sizes().principals;
      const big = await auth(port, "start", { body: { pad: "y".repeat(5000) } });
      assert.equal(big.status, 413, "Play's 4 KiB body cap");
      assert.equal(big.headers["set-cookie"], undefined);
      assert.equal(service.sizes().principals, principals);
    } finally {
      await stopServer(server);
    }
  });

  test("the read-only routes still never set a cookie (only auth/* may)", async () => {
    const { server, port } = await ludumServer();
    try {
      const account = await accountBrowser(port, "ivy", PASSWORD, "Ivy");
      for (const route of ["session", "games", "account", "case", "moderation-queue"]) {
        for (const cookie of [account.cookie, undefined]) {
          const answer = await apiRequest(port, `${LUDUM_PREFIX}${route}`, { origin: LUDUM, ...(cookie ? { cookie } : {}), body: route === "case" ? { chainGameId: "1" } : {} });
          assert.equal(answer.headers["set-cookie"], undefined, `${route}`);
        }
      }
    } finally {
      await stopServer(server);
    }
  });
});
