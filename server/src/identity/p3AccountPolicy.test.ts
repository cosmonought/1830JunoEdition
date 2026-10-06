// server/src/identity/p3AccountPolicy.test.ts
//
// ==================================================================
//  PHASE 3 -- ACCOUNT POLICY / RECOVERY FOLLOW-UP (owner rulings 2026-10-05): ADVERSARIAL TESTS
// ==================================================================
//
// Against the real server (production identity: cookies, an allowed Origin, real sockets) and the identity service:
//   A. the password policy: 12 characters, no composition rule, long passphrases;
//   B. the recovery key: exactly one per new account, in ONE answer only; never a sign-in, never a standing grant;
//   C. change password: the current password OR the recovery key, in the request; every other device signed out; this
//      browser kept on a fresh session (same family); old password dead, new one live; wallet and seats untouched;
//   D. forgot password: the key + a new password; non-enumerating refusals; every earlier session ends; this browser is
//      signed in fresh; the key is kept (not rotated); a legacy profile with no password is told so;
//   E. recovery-key rotation: only an EXPLICIT "Confirm it's you"; the old key dies at once; one key at a time;
//   F. the credential fences: a stale writer is refused by the store (profile-password); a reset racing a change;
//      the journal replay never brings an old password back;
//   G. legacy profiles: migration still works; the legacy key establishes credentials safely, then only recovers;
//   H. trust: "established opponents" (completed real-money games only; each opponent once).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createMemoryRecordStore } from "../rooms/recordStore";
import { accountBrowser, apiRequest, bootstrapCookie, Client, cookieFromAnswer, cookieRead, loginOnFreshBrowser, PROD_ORIGIN, profiledBrowser, quietConsole, sleep, startServer, stopServer, type ApiAnswer } from "../rooms/testSupport";
import { TEST_PASSWORD_KDF } from "../escrow/escrow4Support";
import { createTrustFacts, isEstablished } from "../rooms/trustFacts";
import type { GameRecord } from "../rooms/gameRecord";
import type { FinancialGameRecord } from "../escrow/moneyLifecycle";
import { StoreDefiniteError } from "../persistence/storeResult";
import { hashPassword, hasRecoveryKey, PASSWORD_MIN_LENGTH, verifyPassword } from "./accountCredentials";
import { readSessionCookie } from "./cookies";
import { createMemoryGrantStore } from "./grants";
import { planSecurityReplay, SecurityReplayError } from "./securityReplay";
import { createMemorySecurityJournal, parseSecurityEventBody, SECURITY_EVENT_FORMAT, SECURITY_EVENT_VERSION, type SecurityEvent } from "./securityEvents";
import { IdentityService } from "./sessions";
import { applyChange, createMemoryIdentityStore, loginOf, type Profile } from "./store";
import { FIXTURE_WALLET } from "../persistence/conformance/fixtures";

quietConsole();

const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a brand new passphrase";
/** A secret of the right SHAPE (42 symbols + a final one a 32-byte value can end in) that is not the key's: it reaches
 *  the constant-time comparison (a malformed one is refused before it -- the mutation run showed the difference). */
const WELL_FORMED_WRONG_SECRET = `${"B".repeat(42)}A`;

async function prodServer(over: { service?: IdentityService; records?: ReturnType<typeof createMemoryRecordStore> } = {}) {
  const clock = { now: Date.now() };
  const service = over.service ?? IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
  const started = await startServer({
    identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, now: () => clock.now, service },
    ...(over.records ? { records: over.records } : {}),
  });
  return { ...started, clock, service };
}

const post = (port: number, pathname: string, cookie?: string, body: object = {}) => apiRequest(port, pathname, { cookie, body });
const session = (port: number, cookie: string) => post(port, "/gs/api/session", cookie);
const create = (port: number, cookie: string, body: object) => post(port, "/gs/api/account/create", cookie, body);
const login = (port: number, cookie: string, username: string, password: string) => post(port, "/gs/api/account/login", cookie, { username, password });
const changePassword = (port: number, cookie: string, body: object) => post(port, "/gs/api/account/password", cookie, body);
const reset = (port: number, cookie: string, body: object) => post(port, "/gs/api/account/reset", cookie, body);
const principalOf = (service: IdentityService, cookie: string, now: number): string | null => {
  const auth = service.authenticate(readSessionCookie(cookie), now);
  return auth.kind === "ok" ? auth.principalId : null;
};
/** Status, headers (less the clock) and body: two refusals compared for sameness. */
function observable(answer: ApiAnswer): string {
  const { date: _date, connection: _connection, "keep-alive": _keepAlive, ...headers } = answer.headers;
  return JSON.stringify({ status: answer.status, headers, text: answer.text });
}
/** No private id, hash, selector or password anywhere in an answer. */
const PRIVATE = /pr_|pf_|se_|sf_|rk_|scrypt\$|password_hash|login_key|recovery_hash|recovery_selector/;

/** A new account over HTTP, with its one-time recovery key. */
async function account(port: number, username: string, password = PASSWORD): Promise<{ cookie: string; recoveryKey: string }> {
  const before = await bootstrapCookie(port);
  const created = await create(port, before, { username, password, name: username.slice(0, 24) });
  const cookie = cookieFromAnswer(created);
  assert.equal(created.status, 201, created.text);
  assert.ok(cookie !== null);
  return { cookie, recoveryKey: (created.body as { recoveryKey: string }).recoveryKey };
}

/* ==================================================================
    A. THE PASSWORD POLICY
   ================================================================== */

describe("account policy A: the password is at least 12 characters, with no composition rule", () => {
  test("a new account refuses 11 characters and takes 12; letters-only, digits-only, spaces and long passphrases are all accepted", async () => {
    const { server, port } = await prodServer();
    try {
      assert.equal(PASSWORD_MIN_LENGTH, 12);
      const eleven = await create(port, await bootstrapCookie(port), { username: "Eleven", password: "abcdefghijk", name: "Eleven" });
      assert.deepEqual([eleven.status, eleven.body], [400, { error: "bad-password", problem: "too-short" }]);
      /* 11 code points even when it is more bytes: the floor counts characters. */
      const elevenWide = await create(port, await bootstrapCookie(port), { username: "Wide", password: "ééééééééééé", name: "Wide" });
      assert.deepEqual(elevenWide.body, { error: "bad-password", problem: "too-short" });
      for (const [username, password] of [
        ["Twelve", "abcdefghijkl"],
        ["Digits", "123456789012"],
        ["Spaces", "a b c d e f "],
        ["Phrase", "the quick brown fox jumps over the lazy dog ".repeat(10)],
      ] as const) {
        const made = await create(port, await bootstrapCookie(port), { username, password, name: username });
        assert.equal(made.status, 201, `${username}: ${made.text}`);
        assert.equal((await login(port, await bootstrapCookie(port), username, password)).status, 200, `${username} logs in`);
      }
      /* The technical bound is unchanged (1 KiB of UTF-8). */
      const huge = await create(port, await bootstrapCookie(port), { username: "Huge", password: "x".repeat(1025), name: "Huge" });
      assert.equal(huge.status, 400);
    } finally {
      await stopServer(server);
    }
  });

  test("a new password (change, reset) meets the same floor; a sign-in never re-judges a password the account already has", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      assert.deepEqual((await changePassword(port, ann.cookie, { currentPassword: PASSWORD, newPassword: "short" })).body, { error: "bad-password", problem: "too-short" });
      assert.deepEqual((await reset(port, await bootstrapCookie(port), { recoveryKey: ann.recoveryKey, newPassword: "elevenchars" })).body, { error: "bad-password", problem: "too-short" });
      assert.equal((await login(port, await bootstrapCookie(port), "ann", PASSWORD)).status, 200, "nothing changed");
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    B. THE RECOVERY KEY: ONE, SHOWN ONCE, NEVER A SIGN-IN
   ================================================================== */

describe("account policy B: one recovery key per new account, delivered once, account recovery only", () => {
  test("create answers exactly one key (stored as selector + digest only); no later answer carries it; routine login, Host and Join never ask for it", async () => {
    const records = createMemoryRecordStore();
    const { server, port, clock, service } = await prodServer({ records });
    try {
      const before = await bootstrapCookie(port);
      const created = await create(port, before, { username: "Hana", password: PASSWORD, name: "Hana" });
      assert.equal(created.status, 201);
      const key = (created.body as { recoveryKey: string }).recoveryKey;
      assert.equal(created.text.split("rk_").length - 1, 1, "exactly one key in the one answer");
      assert.equal(created.headers["cache-control"], "no-store");
      const cookie = cookieFromAnswer(created) as string;
      const principal = principalOf(service, cookie, clock.now) as string;
      const profile = service.peekProfileOf(principal) as Profile;
      assert.equal(hasRecoveryKey(profile), true);
      assert.equal(profile.recovery_selector, key.split(".")[0], "ONE key: its selector is the profile's only one");
      assert.ok(!JSON.stringify(profile).includes(key.split(".")[1]), "the secret is never stored");
      /* Nothing else ever answers it. */
      for (const answer of [await session(port, cookie), await post(port, "/gs/api/account/me", cookie), await post(port, "/gs/api/trust/me", cookie)]) {
        assert.ok(!answer.text.includes("rk_") && !answer.text.includes(key.split(".")[1]), answer.text);
        assert.ok(!PRIVATE.test(answer.text), answer.text);
      }
      /* Routine play: Host on this browser, and a subsequent login + Join elsewhere -- no key anywhere. */
      const hostClient = await Client.openWithCookie(port, cookie, "hana");
      const table = await hostClient.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "" });
      assert.equal(table.ok, true, JSON.stringify(table));
      await account(port, "Jo");
      const joLogin = await loginOnFreshBrowser(port, "jo", PASSWORD);
      assert.equal(joLogin.answer.status, 200, "a routine login: username and password only");
      const jo = await Client.openWithCookie(port, joLogin.cookie as string, "jo");
      const joined = await jo.op({ type: "join", code: (table.data as { code: string }).code, takeSeat: true });
      assert.equal(joined.ok, true, JSON.stringify(joined));
      await jo.close();
      await hostClient.close();
    } finally {
      await stopServer(server);
    }
  });

  test("the key of an account with a password is NOT a sign-in (recover: 409, no cookie) and NOT a standing grant (Confirm it's you: invalid) -- only recovery", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      const fresh = await bootstrapCookie(port);
      const keyed = await post(port, "/gs/api/profile/recover", fresh, { recoveryKey: ann.recoveryKey });
      assert.deepEqual([keyed.status, keyed.body], [409, { error: "use-password-reset" }]);
      assert.equal(cookieFromAnswer(keyed), null, "no session issued");
      assert.equal(((await session(port, fresh)).body as { profile: unknown }).profile, null, "this browser is still a visitor");
      const confirm = await post(port, "/gs/api/profile/reauth", ann.cookie, { recoveryKey: ann.recoveryKey });
      assert.deepEqual([confirm.status, confirm.body], [403, { error: "invalid-credential" }], "the key makes no grant");
      /* A wrong key at recover is still the one wrong answer. */
      assert.deepEqual((await post(port, "/gs/api/profile/recover", await bootstrapCookie(port), { recoveryKey: `${ann.recoveryKey.split(".")[0]}.${"A".repeat(43)}` })).body, { error: "invalid-credential" });
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    C. CHANGE PASSWORD
   ================================================================== */

describe("account policy C: change password", () => {
  test("a wrong current password (or a wrong key, or another account's key) changes nothing; one credential exactly", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      const bea = await account(port, "Bea");
      const principal = principalOf(service, ann.cookie, clock.now) as string;
      const hashBefore = loginOf(service.peekProfileOf(principal) as Profile)?.hash;
      for (const body of [
        { currentPassword: "not the password", newPassword: NEW_PASSWORD },
        { recoveryKey: `${ann.recoveryKey.split(".")[0]}.${WELL_FORMED_WRONG_SECRET}`, newPassword: NEW_PASSWORD },
        { recoveryKey: bea.recoveryKey, newPassword: NEW_PASSWORD },
        { recoveryKey: "not a key", newPassword: NEW_PASSWORD },
      ]) {
        const refused = await changePassword(port, ann.cookie, body);
        assert.deepEqual([refused.status, refused.body], [403, { error: "invalid-credential" }], JSON.stringify(body));
        assert.equal(cookieFromAnswer(refused), null);
      }
      assert.equal((await changePassword(port, ann.cookie, { currentPassword: PASSWORD, recoveryKey: ann.recoveryKey, newPassword: NEW_PASSWORD })).status, 400, "never both");
      assert.equal((await changePassword(port, ann.cookie, { newPassword: NEW_PASSWORD })).status, 400, "never neither");
      assert.equal(loginOf(service.peekProfileOf(principal) as Profile)?.hash, hashBefore, "the password is unchanged");
      assert.equal(((await session(port, ann.cookie)).body as { profile: unknown }) !== null, true);
      assert.equal((await session(port, ann.cookie)).status, 200, "and this browser is still signed in");
      /* A visitor cannot change anything. */
      assert.deepEqual((await changePassword(port, await bootstrapCookie(port), { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).body, { error: "profile-required" });
    } finally {
      await stopServer(server);
    }
  });

  test("the current password changes it: every OTHER device is signed out (sockets 4401), this browser continues on a fresh cookie; old password dead, new one live", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      const phone = await loginOnFreshBrowser(port, "ann", PASSWORD);
      const tablet = await loginOnFreshBrowser(port, "ann", PASSWORD);
      const principal = principalOf(service, ann.cookie, clock.now) as string;
      const phoneSocket = await Client.openWithCookie(port, phone.cookie as string, "phone");
      const mySocket = await Client.openWithCookie(port, ann.cookie, "mine");
      const changed = await changePassword(port, ann.cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      assert.equal(changed.status, 200, changed.text);
      assert.deepEqual(changed.body, { ok: true, signedOut: 2 });
      assert.ok(!PRIVATE.test(changed.text));
      const fresh = cookieFromAnswer(changed) as string;
      assert.ok(fresh !== null && fresh !== ann.cookie, "a fresh session for this browser");
      assert.equal(await phoneSocket.closed, 4401, "the other device's socket is closed");
      assert.equal(await mySocket.closed, 4401, "this browser's old socket too (it reopens on the fresh cookie)");
      for (const other of [phone.cookie, tablet.cookie]) assert.deepEqual((await session(port, other as string)).body, { error: "session-ended", reason: "signed-out-remotely" });
      assert.deepEqual((await session(port, ann.cookie)).body, { error: "session-ended", reason: "replaced" }, "a copy of this browser's old cookie opens nothing");
      const boot = await session(port, fresh);
      assert.equal(boot.status, 200);
      assert.deepEqual((boot.body as { profile: unknown }).profile, { name: "Ann", otherSessions: 0 }, "still signed in, alone");
      assert.equal(principalOf(service, fresh, clock.now), principal, "the same principal: every seat stays");
      const freshFamily = service.peekSession(fresh.split(".")[1])?.family_id;
      assert.equal(freshFamily, service.peekSession(ann.cookie.split(".")[1])?.family_id, "the same family: this device's wallet links keep standing");
      assert.equal((await login(port, await bootstrapCookie(port), "ann", PASSWORD)).status, 403, "the old password stops working");
      assert.equal((await login(port, await bootstrapCookie(port), "ann", NEW_PASSWORD)).status, 200, "the new one works");
      /* The fresh session works on a socket. */
      const again = await Client.openWithCookie(port, fresh, "again");
      assert.equal(again.open, true);
      await again.close();
    } finally {
      await stopServer(server);
    }
  });

  test("the recovery key changes it too (a signed-in player who forgot the password); the key stays the account's key", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      const changed = await changePassword(port, ann.cookie, { recoveryKey: ann.recoveryKey, newPassword: NEW_PASSWORD });
      assert.equal(changed.status, 200, changed.text);
      assert.equal((await login(port, await bootstrapCookie(port), "ann", NEW_PASSWORD)).status, 200);
      assert.equal((await login(port, await bootstrapCookie(port), "ann", PASSWORD)).status, 403);
      /* The key still recovers the account (it was not rotated). */
      assert.equal((await reset(port, await bootstrapCookie(port), { recoveryKey: ann.recoveryKey, newPassword: "and a third passphrase" })).status, 200);
    } finally {
      await stopServer(server);
    }
  });

  test("a sign-in's standing grant never changes the password: the credential must be in the request (a cookie stolen in the five minutes is not enough)", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      assert.equal(service.hasSensitiveAuth(readSessionCookie(ann.cookie), clock.now), true, "the sign-in's grant is live");
      assert.equal((await changePassword(port, ann.cookie, { newPassword: NEW_PASSWORD })).status, 400);
      assert.equal((await changePassword(port, ann.cookie, { currentPassword: "", newPassword: NEW_PASSWORD })).status, 403);
    } finally {
      await stopServer(server);
    }
  });

  test("the verified wallet, the seats and the profile survive a password change; only the other devices' standing ends", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      const phone = await loginOnFreshBrowser(port, "ann", PASSWORD);
      const principal = principalOf(service, ann.cookie, clock.now) as string;
      const mine = service.securityContextOf(readSessionCookie(ann.cookie), clock.now);
      const theirs = service.securityContextOf(readSessionCookie(phone.cookie as string), clock.now);
      assert.ok(mine !== null && theirs !== null);
      assert.equal(await service.associateWallet({ ...mine, seen: null }, FIXTURE_WALLET, clock.now), "associated");
      const client = await Client.openWithCookie(port, ann.cookie, "ann");
      const table = await client.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "" });
      assert.equal(table.ok, true);
      const profileBefore = service.peekProfileOf(principal) as Profile;
      const changed = await changePassword(port, ann.cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      assert.equal(changed.status, 200);
      await client.closed;
      const profileAfter = service.peekProfileOf(principal) as Profile;
      assert.deepEqual(service.profileWallet(principal), { address: FIXTURE_WALLET, verifiedAt: clock.now }, "the verified wallet is kept");
      assert.deepEqual(
        [profileAfter.profile_id, profileAfter.principal_id, profileAfter.display_name, profileAfter.created_at, profileAfter.login_key, profileAfter.recovery_selector, profileAfter.recovery_hash],
        [profileBefore.profile_id, profileBefore.principal_id, profileBefore.display_name, profileBefore.created_at, profileBefore.login_key, profileBefore.recovery_selector, profileBefore.recovery_hash],
        "identity, username and recovery key untouched",
      );
      assert.deepEqual(service.securityStanding(mine), { kind: "standing" }, "this device's credentials keep standing (same family, same key epoch)");
      assert.deepEqual(service.securityStanding(theirs), { kind: "ended", why: "family" }, "the other device's end");
      const fresh = cookieFromAnswer(changed) as string;
      const again = await Client.openWithCookie(port, fresh, "ann-again");
      const tables = await again.op({ type: "my-tables" });
      assert.ok(JSON.stringify(tables).includes((table.data as { gameId: string }).gameId), "the seat is still this account's");
      await again.close();
    } finally {
      await stopServer(server);
    }
  });

  test("a profile with no password (made before accounts) is told to set one instead", async () => {
    const { server, port } = await prodServer();
    try {
      const legacy = await profiledBrowser(port, "Old Timer");
      assert.deepEqual((await changePassword(port, legacy.cookie, { recoveryKey: legacy.recoveryKey, newPassword: NEW_PASSWORD })).body, { error: "no-password" });
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    D. FORGOT PASSWORD
   ================================================================== */

describe("account policy D: forgot password (the recovery key, no email, no username)", () => {
  test("a valid key resets: every earlier session ends (sockets 4401), this browser is signed in fresh, old password dead, new live, key kept", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      const phone = await loginOnFreshBrowser(port, "ann", PASSWORD);
      const principal = principalOf(service, ann.cookie, clock.now) as string;
      const sockets = [await Client.openWithCookie(port, ann.cookie, "ann"), await Client.openWithCookie(port, phone.cookie as string, "phone")];
      const browser = await bootstrapCookie(port);
      const done = await reset(port, browser, { recoveryKey: ann.recoveryKey, newPassword: NEW_PASSWORD });
      assert.equal(done.status, 200, done.text);
      assert.deepEqual(done.body, { ok: true, profile: { name: "Ann" }, signedOut: 2 });
      assert.ok(!PRIVATE.test(done.text));
      const fresh = cookieFromAnswer(done) as string;
      assert.ok(fresh !== null && fresh !== browser);
      for (const socket of sockets) assert.equal(await socket.closed, 4401);
      for (const old of [ann.cookie, phone.cookie as string]) assert.deepEqual((await session(port, old)).body, { error: "session-ended", reason: "signed-out-remotely" });
      assert.deepEqual((await session(port, browser)).body, { error: "session-ended", reason: "replaced" }, "the visitor cookie the reset was made from opens nothing (fixation)");
      assert.deepEqual(((await session(port, fresh)).body as { profile: unknown }).profile, { name: "Ann", otherSessions: 0 });
      assert.equal(principalOf(service, fresh, clock.now), principal, "the same account and seats");
      assert.equal((await login(port, await bootstrapCookie(port), "ann", PASSWORD)).status, 403, "the old password stops working");
      assert.equal((await login(port, await bootstrapCookie(port), "ann", NEW_PASSWORD)).status, 200);
      assert.equal((service.peekProfileOf(principal) as Profile).recovery_selector, ann.recoveryKey.split(".")[0], "the key is kept (not rotated)");
    } finally {
      await stopServer(server);
    }
  });

  test("a wrong key gets ONE answer whatever is wrong -- unknown selector, wrong secret, malformed, a rotated key -- so nothing is enumerated; no username is ever involved", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      const selector = ann.recoveryKey.split(".")[0];
      const unknownSelector = `rk_${"a".repeat(25)}0.${ann.recoveryKey.split(".")[1]}`;
      const answers: ApiAnswer[] = [];
      for (const recoveryKey of [unknownSelector, `${selector}.${WELL_FORMED_WRONG_SECRET}`, "nonsense", ""]) {
        answers.push(await reset(port, await bootstrapCookie(port), { recoveryKey, newPassword: NEW_PASSWORD }));
      }
      for (const answer of answers) {
        assert.deepEqual([answer.status, answer.body], [403, { error: "invalid-credential" }]);
        assert.equal(cookieFromAnswer(answer), null);
      }
      assert.equal(new Set(answers.map(observable)).size, 1, "status, headers and body identical");
      assert.equal((await login(port, await bootstrapCookie(port), "ann", PASSWORD)).status, 200, "nothing changed");
      assert.equal((await reset(port, await bootstrapCookie(port), { username: "ann", recoveryKey: ann.recoveryKey, newPassword: NEW_PASSWORD })).status, 400, "no username field at all");
    } finally {
      await stopServer(server);
    }
  });

  test("a signed-in browser, or one holding tables from before accounts, is not a reset's place; a legacy key with no password is told so (only its holder learns it)", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      assert.deepEqual((await reset(port, ann.cookie, { recoveryKey: ann.recoveryKey, newPassword: NEW_PASSWORD })).body, { error: "already-profiled" });
      const legacy = await profiledBrowser(port, "Old Timer");
      assert.deepEqual((await reset(port, await bootstrapCookie(port), { recoveryKey: legacy.recoveryKey, newPassword: NEW_PASSWORD })).body, { error: "no-password" });
    } finally {
      await stopServer(server);
    }
  });

  test("wrong keys spend the address's failure budget; the right key still resets", async () => {
    const service = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
    const clock = { now: Date.now() };
    const started = await startServer({
      identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, now: () => clock.now, service },
      limits: { identity: { credentialRedeemsPerIp: { capacity: 2, refillPerSecond: 0.000001 } } },
    });
    try {
      const ann = await account(started.port, "Ann");
      const wrong = { recoveryKey: `${ann.recoveryKey.split(".")[0]}.${WELL_FORMED_WRONG_SECRET}`, newPassword: NEW_PASSWORD };
      const statuses: number[] = [];
      for (let n = 0; n < 4; n += 1) statuses.push((await reset(started.port, await bootstrapCookie(started.port), wrong)).status);
      assert.deepEqual(statuses.slice(2), [429, 429], "spent");
      assert.equal((await reset(started.port, await bootstrapCookie(started.port), { recoveryKey: ann.recoveryKey, newPassword: NEW_PASSWORD })).status, 200, "the right key is never stopped by it");
    } finally {
      await stopServer(started.server);
    }
  });
});

/* ==================================================================
    E. RECOVERY-KEY ROTATION
   ================================================================== */

describe("account policy E: a new recovery key", () => {
  test("needs an explicit Confirm it's you (the password) -- never the sign-in's grant; the old key dies at once (reset, change, recover); the new one works; one key at a time", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      const principal = principalOf(service, ann.cookie, clock.now) as string;
      assert.deepEqual((await post(port, "/gs/api/profile/recovery-key", ann.cookie)).body, { error: "reauth-required" });
      assert.equal((await post(port, "/gs/api/profile/reauth", ann.cookie, { password: PASSWORD })).status, 200);
      const rotated = await post(port, "/gs/api/profile/recovery-key", ann.cookie);
      assert.equal(rotated.status, 200, rotated.text);
      const newKey = (rotated.body as { recoveryKey: string }).recoveryKey;
      assert.notEqual(newKey, ann.recoveryKey);
      assert.equal((service.peekProfileOf(principal) as Profile).recovery_selector, newKey.split(".")[0], "one key: the new one");
      assert.deepEqual((await reset(port, await bootstrapCookie(port), { recoveryKey: ann.recoveryKey, newPassword: NEW_PASSWORD })).body, { error: "invalid-credential" }, "the old key no longer resets");
      assert.deepEqual((await changePassword(port, ann.cookie, { recoveryKey: ann.recoveryKey, newPassword: NEW_PASSWORD })).body, { error: "invalid-credential" }, "nor confirms a change");
      assert.deepEqual((await post(port, "/gs/api/profile/recover", await bootstrapCookie(port), { recoveryKey: ann.recoveryKey })).body, { error: "invalid-credential" });
      assert.equal((await reset(port, await bootstrapCookie(port), { recoveryKey: newKey, newPassword: NEW_PASSWORD })).status, 200, "the new one does");
    } finally {
      await stopServer(server);
    }
  });

  test("across a restart (OD-5-4): an explicit Confirm it's you is reloaded and still makes a key; a sign-in's automatic grant is memory only and is not", async () => {
    const store = createMemoryIdentityStore();
    const grantStore = createMemoryGrantStore();
    const clock = { now: Date.now() };
    const options = { policy: { passwordKdf: TEST_PASSWORD_KDF }, security: { grants: grantStore, clock: () => clock.now } };
    const first = await IdentityService.open(store, options);
    const a = await prodServer({ service: first });
    let confirmed: string;
    let signedIn: string;
    try {
      confirmed = (await account(a.port, "Ann")).cookie;
      assert.equal((await post(a.port, "/gs/api/profile/reauth", confirmed, { password: PASSWORD })).status, 200);
      signedIn = (await account(a.port, "Bea")).cookie;
    } finally {
      await stopServer(a.server);
    }
    assert.equal((await grantStore.live(clock.now)).length, 1, "only the confirmation was written");
    const second = await IdentityService.open(store, options);
    assert.equal(second.hasSensitiveAuth(readSessionCookie(signedIn), clock.now), false, "the sign-in's grant did not survive");
    assert.equal(second.hasSensitiveAuth(readSessionCookie(confirmed), clock.now), true, "the confirmation did");
    assert.equal((await second.rotateRecoveryKey(readSessionCookie(confirmed), clock.now)).kind, "ok");
    assert.equal((await second.rotateRecoveryKey(readSessionCookie(signedIn), clock.now)).kind, "reauth-required");
  });
});

/* ==================================================================
    F. THE CREDENTIAL FENCES
   ================================================================== */

async function guestOf(service: IdentityService, now: number) {
  const boot = await service.bootstrap({ kind: "none" }, false, now);
  assert.equal(boot.kind, "ok");
  return cookieRead(((boot as { setCookie: string }).setCookie as string).split(";")[0]);
}

describe("account policy F: the credential fences", () => {
  test("a STALE second writer (its view predates a reset) cannot write its own reset over it: the store refuses the superseded password generation", async () => {
    const store = createMemoryIdentityStore();
    const now = Date.now();
    const policy = { passwordKdf: TEST_PASSWORD_KDF };
    const a = IdentityService.fromSnapshot(store, { principals: [], sessions: [] }, { policy });
    const made = await a.createAccount(await guestOf(a, now), { username: "Ann", password: PASSWORD, displayName: "Ann" }, now);
    assert.equal(made.kind, "ok");
    const key = (made as { recoveryKey: string }).recoveryKey;
    /* Every session ends first (so only the password generation can stand between the two writers). */
    await a.revoke((made as { sessionId: string }).sessionId, "logout", now);
    const b = IdentityService.fromSnapshot(store, store.snapshot(), { policy });
    const first = await a.resetPassword(await guestOf(a, now), { recoveryKey: key, newPassword: NEW_PASSWORD }, now);
    assert.equal(first.kind, "ok");
    const stale = await b.resetPassword(await guestOf(b, now), { recoveryKey: key, newPassword: "the attacker's passphrase" }, now);
    assert.equal(stale.kind, "unavailable", "refused by the store (profile-password), nothing written");
    const durable = store.snapshot().profiles[0];
    assert.equal(await verifyPassword(NEW_PASSWORD, loginOf(durable)?.hash ?? null, TEST_PASSWORD_KDF), true, "the first reset stands");
    /* The store's own contract, directly: a change pinned to a superseded hash is DEFINITE, nothing written. */
    const superseded = await hashPassword("x".repeat(12), TEST_PASSWORD_KDF);
    await assert.rejects(store.commit({ expect: [{ kind: "profile-password", profile_id: durable.profile_id, password_hash: superseded }], profiles: [{ ...durable, display_name: "Renamed" }] }), StoreDefiniteError);
  });

  test("a reset racing a password change: whichever lands second is refused (the generation it checked is gone)", async () => {
    const now = Date.now();
    /* A security journal whose append can be held: the change is held INSIDE its commit (journal first), so the reset
       checks the key and the password generation before the change lands, and reaches the queue after it. */
    const inner = createMemorySecurityJournal();
    let hold: Promise<void> | null = null;
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const journal = {
      ...inner,
      append: async (event: SecurityEvent) => {
        if (hold !== null && event.kind === "password-replaced") {
          entered();
          await hold;
        }
        return inner.append(event);
      },
    };
    const store = createMemoryIdentityStore();
    const service = IdentityService.fromSnapshot(store, { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF }, security: { journal } });
    const made = await service.createAccount(await guestOf(service, now), { username: "Ann", password: PASSWORD, displayName: "Ann" }, now);
    const read = cookieRead((made as { setCookie: string }).setCookie.split(";")[0]);
    const key = (made as { recoveryKey: string }).recoveryKey;
    const visitor = await guestOf(service, now);
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => (release = resolve));
    const changing = service.changePassword(read, { current: { password: PASSWORD }, newPassword: NEW_PASSWORD }, now);
    await inside; // the change is committing (its event is being appended), not yet applied
    const resetting = service.resetPassword(visitor, { recoveryKey: key, newPassword: "the other passphrase" }, now);
    await sleep(30); // the reset's checks (and its KDF) run now, against the generation the change is replacing
    release();
    const [changed, reset] = await Promise.all([changing, resetting]);
    assert.equal(changed.kind, "ok");
    assert.equal(reset.kind, "invalid", "the generation the reset checked is gone");
    assert.equal(service.stats.passwordResets, 0);
    assert.equal(await verifyPassword(NEW_PASSWORD, loginOf(store.snapshot().profiles[0])?.hash ?? null, TEST_PASSWORD_KDF), true);
  });

  test("two devices changing at once: one wins; the other is signed out by it and changes nothing", async () => {
    const now = Date.now();
    const service = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
    const made = await service.createAccount(await guestOf(service, now), { username: "Ann", password: PASSWORD, displayName: "Ann" }, now);
    const laptop = cookieRead((made as { setCookie: string }).setCookie.split(";")[0]);
    const signedIn = await service.login(await guestOf(service, now), { username: "ann", password: PASSWORD }, now);
    const phone = cookieRead((signedIn as { setCookie: string }).setCookie.split(";")[0]);
    const results = await Promise.all([
      service.changePassword(laptop, { current: { password: PASSWORD }, newPassword: "laptop's new passphrase" }, now),
      service.changePassword(phone, { current: { password: PASSWORD }, newPassword: "phone's new passphrase" }, now),
    ]);
    assert.deepEqual(results.map((result) => result.kind).sort(), ["not-authenticated", "ok"]);
    assert.equal(service.stats.passwordChanges, 1);
  });

  test("the journal replay never brings an old password back: an identity restored to before the change installs the chain's head", async () => {
    const now = Date.now();
    const store = createMemoryIdentityStore();
    const journal = createMemorySecurityJournal();
    const service = IdentityService.fromSnapshot(store, { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF }, security: { journal } });
    const made = await service.createAccount(await guestOf(service, now), { username: "Ann", password: PASSWORD, displayName: "Ann" }, now);
    let read = cookieRead((made as { setCookie: string }).setCookie.split(";")[0]);
    const key = (made as { recoveryKey: string }).recoveryKey;
    await service.settled();
    const restorePoint = store.snapshot(); // T: the first password
    const changed = await service.changePassword(read, { current: { password: PASSWORD }, newPassword: NEW_PASSWORD }, now + 1);
    assert.equal(changed.kind, "ok");
    read = cookieRead((changed as { setCookie: string }).setCookie.split(";")[0]);
    const third = "the third passphrase";
    assert.equal((await service.resetPassword(await guestOf(service, now + 2), { recoveryKey: key, newPassword: third }, now + 2)).kind, "ok");
    await service.settled();
    const events = journal.snapshot().map((body) => parseSecurityEventBody(body) as SecurityEvent);
    assert.equal(events.filter((event) => event.kind === "password-replaced").length, 2);
    assert.ok(events.every((event) => !JSON.stringify(event).includes(PASSWORD) && !JSON.stringify(event).includes(NEW_PASSWORD) && !JSON.stringify(event).includes(key.split(".")[1])), "hashes only -- no password, no key");
    const plan = planSecurityReplay({ snapshot: restorePoint, events, restoreId: "rs-test", at: now + 10 });
    assert.equal(plan.report.passwords_advanced, 1);
    let restored = restorePoint;
    for (const entry of plan.principals) if (entry.change !== null) restored = applyChange(restored, entry.change);
    const hash = loginOf(restored.profiles[0])?.hash ?? null;
    assert.equal(await verifyPassword(PASSWORD, hash, TEST_PASSWORD_KDF), false, "the first password never comes back");
    assert.equal(await verifyPassword(NEW_PASSWORD, hash, TEST_PASSWORD_KDF), false, "nor the second");
    assert.equal(await verifyPassword(third, hash, TEST_PASSWORD_KDF), true, "the latest one is installed");
    const pinned = plan.principals.flatMap((entry) => entry.change?.expect ?? []).find((condition) => condition.kind === "profile-password");
    assert.ok(pinned !== undefined, "the replay pins the password the table holds");
    /* Idempotent: a second run plans nothing more for the password. */
    assert.equal(planSecurityReplay({ snapshot: restored, events, restoreId: "rs-test", at: now + 10 }).report.passwords_advanced, 0);
    /* Confirmations lost: the last replacement from each password is still followed (the key is the remedy). */
    const unconfirmed = events.filter((event) => event.kind !== "confirmed");
    const guessed = planSecurityReplay({ snapshot: restorePoint, events: unconfirmed, restoreId: "rs-test", at: now + 10 });
    let restored2 = restorePoint;
    for (const entry of guessed.principals) if (entry.change !== null) restored2 = applyChange(restored2, entry.change);
    assert.equal(await verifyPassword(third, loginOf(restored2.profiles[0])?.hash ?? null, TEST_PASSWORD_KDF), true);
  });

  test("the replay is strict: a cycle of replacements, or a table password the journal never names, is refused (fail closed)", async () => {
    const now = Date.now();
    const store = createMemoryIdentityStore();
    const service = IdentityService.fromSnapshot(store, { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
    await service.createAccount(await guestOf(service, now), { username: "Ann", password: PASSWORD, displayName: "Ann" }, now);
    const snapshot = store.snapshot();
    const profile = snapshot.profiles[0];
    const h0 = loginOf(profile)?.hash as string;
    const h1 = await hashPassword(NEW_PASSWORD, TEST_PASSWORD_KDF);
    const h2 = await hashPassword("yet another passphrase", TEST_PASSWORD_KDF);
    const replaced = (id: number, from: string, to: string): SecurityEvent => ({
      format: SECURITY_EVENT_FORMAT,
      version: SECURITY_EVENT_VERSION,
      event_id: id.toString(16).padStart(32, "0"),
      kind: "password-replaced",
      at: now + id,
      principal_id: profile.principal_id,
      profile_id: profile.profile_id,
      from_hash: from,
      to_hash: to,
      set_at: now + id,
      via: "password",
      kept_family_id: null,
      family_ids: [],
    });
    assert.throws(() => planSecurityReplay({ snapshot, events: [replaced(1, h0, h1), replaced(2, h1, h0)], restoreId: "rs", at: now + 9 }), SecurityReplayError);
    assert.throws(() => planSecurityReplay({ snapshot, events: [replaced(1, h1, h2)], restoreId: "rs", at: now + 9 }), SecurityReplayError);
  });
});

/* ==================================================================
    G. LEGACY PROFILES
   ================================================================== */

describe("account policy G: legacy profiles keep their key; migration still works", () => {
  test("a legacy profile still signs in with its key; the key (Confirm it's you) establishes a username and password; from then on the key only recovers", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      const legacy = await profiledBrowser(port, "Old Timer");
      const principal = principalOf(service, legacy.cookie, clock.now) as string;
      const elsewhere = await post(port, "/gs/api/profile/recover", await bootstrapCookie(port), { recoveryKey: legacy.recoveryKey });
      assert.equal(elsewhere.status, 200, "a profile with no password still signs in with its key (it has no other way)");
      const body = { username: "OldTimer", password: PASSWORD };
      assert.deepEqual((await post(port, "/gs/api/account/credentials", legacy.cookie, body)).body, { error: "reauth-required" });
      assert.equal((await post(port, "/gs/api/profile/reauth", legacy.cookie, { recoveryKey: legacy.recoveryKey })).status, 200);
      assert.deepEqual((await post(port, "/gs/api/account/credentials", legacy.cookie, { username: "OldTimer", password: "short" })).body, { error: "bad-password", problem: "too-short" }, "the 12-character floor applies");
      assert.deepEqual((await post(port, "/gs/api/account/credentials", legacy.cookie, body)).body, { ok: true, username: "OldTimer" });
      assert.equal((service.peekProfileOf(principal) as Profile).recovery_selector, legacy.recoveryKey.split(".")[0], "the legacy key is kept");
      assert.deepEqual((await post(port, "/gs/api/profile/recover", await bootstrapCookie(port), { recoveryKey: legacy.recoveryKey })).body, { error: "use-password-reset" });
      const recovered = await reset(port, await bootstrapCookie(port), { recoveryKey: legacy.recoveryKey, newPassword: NEW_PASSWORD });
      assert.equal(recovered.status, 200, "the legacy key resets the password it now protects");
      assert.equal(principalOf(service, cookieFromAnswer(recovered) as string, clock.now), principal);
    } finally {
      await stopServer(server);
    }
  });

  test("a legacy browser's sign-in by link code never has a grant to establish credentials with (only the key confirms)", async () => {
    const { server, port } = await prodServer();
    try {
      const legacy = await profiledBrowser(port, "Old Timer");
      assert.equal((await post(port, "/gs/api/profile/reauth", legacy.cookie, { recoveryKey: legacy.recoveryKey })).status, 200);
      const code = (await post(port, "/gs/api/profile/link-code", legacy.cookie)).body as { code: string };
      const second = await bootstrapCookie(port);
      const linked = await post(port, "/gs/api/profile/link", second, { code: code.code });
      assert.equal(linked.status, 200);
      const linkedCookie = cookieFromAnswer(linked) as string;
      assert.deepEqual((await post(port, "/gs/api/account/credentials", linkedCookie, { username: "Taker", password: PASSWORD })).body, { error: "reauth-required" });
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    H. TRUST: ESTABLISHED OPPONENTS
   ================================================================== */

const NOW = Date.UTC(2026, 9, 5);
let gameCount = 0;
function record(seats: readonly string[], over: { money?: boolean; completed?: boolean; cancelled?: boolean } = {}): GameRecord {
  gameCount += 1;
  return {
    game_id: `g_${gameCount}`,
    money: over.money === false ? null : ({} as GameRecord["money"]),
    completed_at: over.completed === false ? null : NOW - gameCount,
    cancelled_at: over.cancelled === true ? NOW - gameCount : null,
    created_at: NOW - 1000 + gameCount,
    seats: seats.map((principal_id, at) => ({ principal_id, player_id: `p-${at}` })),
  } as unknown as GameRecord;
}
const fin = (phase: string, state?: "SETTLED" | "ANNULLED" | "CANCELLED") => ({ phase, chain_outcome: state === undefined ? null : { state, route: "consent", observed_at: NOW } }) as unknown as FinancialGameRecord;

function world(tables: Array<{ record: GameRecord; fin: FinancialGameRecord | null | "throws" }>, profiles: readonly string[]) {
  return createTrustFacts({
    profileFacts: (principalId) => (profiles.includes(principalId) ? { createdAt: NOW - 30 * 86_400_000, walletVerifiedAt: null } : null),
    tablesOf: (principalId) => tables.map((table) => table.record).filter((one) => one.seats.some((seat) => seat.principal_id === principalId)),
    financial: async (gameId) => {
      const found = tables.find((table) => table.record.game_id === gameId);
      if (found === undefined) return null;
      if (found.fin === "throws") throw new Error("unreadable");
      return found.fin;
    },
    now: () => NOW,
    reuseMs: 0,
  });
}

describe("account policy H: trust -- 'established' is one completed real-money game", () => {
  test("distinct established opponents: completed money games only; a repeat opponent once; free, cancelled, annulled, unreadable games and missing profiles never count", async () => {
    const me = "pr_me";
    const tables = [
      { record: record([me, "pr_a"]), fin: fin("closed", "SETTLED") },
      { record: record([me, "pr_a", "pr_b"]), fin: fin("settleable") }, // a repeat opponent, and a new one
      { record: record([me, "pr_c"]), fin: fin("closed", "ANNULLED") }, // annulled (play went on to the end)
      { record: record([me, "pr_d"], { completed: false, cancelled: true }), fin: fin("cancelled", "CANCELLED") },
      { record: record([me, "pr_e"], { money: false }), fin: null }, // a free game
      { record: record([me, "pr_f"]), fin: "throws" as const }, // cannot be read now: never counted
      { record: record([me, "pr_g"]), fin: fin("closed", "SETTLED") }, // pr_g has no active profile
      { record: record([me, "pr_h"], { completed: false }), fin: fin("in-progress") }, // not completed yet
    ];
    const facts = world(tables, [me, "pr_a", "pr_b", "pr_c", "pr_d", "pr_e", "pr_f", "pr_h"]);
    const mine = await facts.factsOf(me);
    assert.equal(mine?.completedMoneyGames, 3, "g1, g2 and g7");
    assert.equal(mine?.establishedOpponents, 2, "pr_a (once, for two games) and pr_b");
    assert.ok(!JSON.stringify(mine).includes("pr_"), "no id in the facts");
    for (const other of ["pr_c", "pr_d", "pr_e", "pr_f", "pr_h"]) {
      const theirs = await facts.factsOf(other);
      assert.equal(theirs?.completedMoneyGames, 0, other);
      assert.equal(isEstablished(theirs as { completedMoneyGames: number }), false, `${other}: annulled, cancelled, free, unreadable or unfinished games establish nobody`);
      assert.equal(theirs?.establishedOpponents, 0);
    }
    assert.equal(isEstablished((await facts.factsOf("pr_a")) as { completedMoneyGames: number }), true);
    assert.equal((await facts.factsOf("pr_a"))?.establishedOpponents, 2, "pr_a: me (twice, counted once) and pr_b");
  });

  test("a game completing makes its opponent established -- and only then do they count", async () => {
    const me = "pr_me";
    const pending = record([me, "pr_x"], { completed: false });
    const tables = [{ record: pending, fin: fin("in-progress") as FinancialGameRecord | null | "throws" }];
    const facts = world(tables, [me, "pr_x"]);
    assert.equal((await facts.factsOf(me))?.establishedOpponents, 0);
    (pending as { completed_at: number | null }).completed_at = NOW;
    tables[0].fin = fin("settleable");
    assert.equal((await facts.factsOf(me))?.establishedOpponents, 1);
    assert.equal((await facts.factsOf("pr_x"))?.establishedOpponents, 1);
  });

  test("no account-age requirement, and no inference from shared networks or devices (only the records are read)", async () => {
    const me = "pr_me";
    const facts = createTrustFacts({
      profileFacts: (principalId) => ({ createdAt: NOW, walletVerifiedAt: null }), // both made just now
      tablesOf: (principalId) => [record([me, "pr_new"])].filter((one) => one.seats.some((seat) => seat.principal_id === principalId)),
      financial: async () => fin("closed", "SETTLED"),
      now: () => NOW,
      reuseMs: 0,
    });
    const mine = await facts.factsOf(me);
    assert.equal(mine?.accountAgeDays, 0);
    assert.equal(mine?.establishedOpponents, 1, "a brand-new account that completed a money game is established");
  });
});

