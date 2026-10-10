// server/src/identity/p3AccountPolicy.test.ts
//
// ==================================================================
//  PHASE 3 -- ACCOUNT POLICY (owner rulings 2026-10-05; PHASE 3 FINAL 2026-10-06): ADVERSARIAL TESTS
// ==================================================================
//
// Against the real server (production identity: cookies, an allowed Origin, real sockets) and the identity service:
//   A. the password policy: 12 characters, no composition rule, long passphrases;
//   B. NO recovery key: none is made, shown, stored or accepted; its routes are retired (410); routine play never asks
//      for the Authorization Wallet;
//   C. change password: the current password, in the request; every other device signed out; this browser kept on a
//      fresh session (same family); old password dead, new one live; the Authorization Wallet and seats untouched;
//   D. forgot password: the Authorization Wallet signs a fresh RECOVER text + a new password; non-enumerating refusals;
//      every earlier session ends; this browser is signed in fresh; the Authorization Wallet is kept;
//   E. changing the Authorization Wallet: only an EXPLICIT "Confirm it's you"; both wallets sign; the old one dies at
//      once; one Authorization Wallet at a time; a confirmation survives a restart, a sign-in's grant does not;
//   F. the credential fences: a stale writer is refused by the store (profile-password); a recovery racing a change;
//      the journal replay never brings an old password back;
//   G. legacy profiles (made before Authorization Wallets): retired -- no migration;
//   H. trust: "established opponents" (completed real-money games only; each opponent once).
// PHASE 3 FINAL deleted (owner ruling 2026-10-06: the recovery key is gone): B's "the key is no sign-in / no grant", C's
// "the recovery key changes it too", D's "a reset forgets the verified wallet" (no profile wallet exists) and every
// reset-by-key, E's key rotation, F's "a migrated legacy profile restores", and G's legacy-key migration and link-code
// grant -- each block below names what replaced it.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";

import { createMemoryRecordStore } from "../rooms/recordStore";
import { apiRequest, bootstrapCookie, Client, cookieFromAnswer, cookieRead, loginOnFreshBrowser, PROD_ORIGIN, quietConsole, sleep, startServer, stopServer, type ApiAnswer } from "../rooms/testSupport";
import { TEST_PASSWORD_KDF } from "../escrow/escrow4Support";
import { createAccountWith, keplrAccount, recoverWith, TEST_SITE, type KeplrAccount } from "../testSupport/authorizationWallets";
import { createTrustFacts, INCOMPLETE_REUSE_MS, isEstablished } from "../rooms/trustFacts";
import type { GameRecord } from "../rooms/gameRecord";
import type { FinancialGameRecord } from "../escrow/moneyLifecycle";
import { StoreDefiniteError } from "../persistence/storeResult";
import { hashPassword, hasRecoveryKey, loginKeyOf, PASSWORD_MIN_LENGTH, sealedRecoveryDigest, verifyPassword } from "./accountCredentials";
import { readSessionCookie } from "./cookies";
import { createMemoryGrantStore } from "./grants";
import { familyIdOf, mintPrincipalId, mintProfileId, mintRecoverySelector, mintSecret, mintSessionId, secretHash } from "./ids";
import { planSecurityReplay, SecurityReplayError } from "./securityReplay";
import { createMemorySecurityJournal, parseSecurityEventBody, SECURITY_EVENT_FORMAT, SECURITY_EVENT_VERSION, type SecurityEvent } from "./securityEvents";
import { IdentityService } from "./sessions";
import { applyChange, createMemoryIdentityStore, loginOf, type Principal, type Profile, type Session, type SessionFamily } from "./store";

quietConsole();

const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a brand new passphrase";
const POLICY = { passwordKdf: TEST_PASSWORD_KDF };

async function prodServer(over: { service?: IdentityService; records?: ReturnType<typeof createMemoryRecordStore>; limits?: Record<string, unknown> } = {}) {
  const clock = { now: Date.now() };
  const service = over.service ?? IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: POLICY });
  const started = await startServer({
    identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, now: () => clock.now, service },
    ...(over.records ? { records: over.records } : {}),
    limits: { identity: { ...(over.limits ?? {}) } },
  });
  return { ...started, clock, service };
}

const post = (port: number, pathname: string, cookie?: string, body: object = {}) => apiRequest(port, pathname, { cookie, body });
const session = (port: number, cookie: string, body: object = {}) => post(port, "/gs/api/session", cookie, body);
const login = (port: number, cookie: string, username: string, password: string) => post(port, "/gs/api/account/login", cookie, { username, password });
const changePassword = (port: number, cookie: string, body: object) => post(port, "/gs/api/account/password", cookie, body);
const reauth = (port: number, cookie: string, password: string) => post(port, "/gs/api/profile/reauth", cookie, { password });
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

/** Each test username's Authorization Wallet (a deterministic test Keplr account). */
const walletFor = (username: string): KeplrAccount => keplrAccount(`policy/${username}`);

/** Create an account over HTTP: the CREATE text for this browser and username, signed by the wallet, then the create.
 *  A refused CREATE text is answered as it came. */
async function create(port: number, cookie: string, body: { username: string; password: string; name: string }, wallet: KeplrAccount = walletFor(body.username)): Promise<ApiAnswer> {
  const minted = await post(port, "/gs/api/account/authorization", cookie, { purpose: "create", username: body.username, wallet: wallet.address });
  if (minted.status !== 200) return minted;
  const text = (minted.body?.texts as Array<{ text: string }>)[0].text;
  return post(port, "/gs/api/account/create", cookie, { ...body, operation: minted.body?.operation, ...wallet.sign(text) });
}

/** A new account over HTTP, with its Authorization Wallet. */
async function account(port: number, username: string, password = PASSWORD): Promise<{ cookie: string; wallet: KeplrAccount }> {
  const wallet = walletFor(username);
  const created = await create(port, await bootstrapCookie(port), { username, password, name: username.slice(0, 24) }, wallet);
  const cookie = cookieFromAnswer(created);
  assert.equal(created.status, 201, created.text);
  assert.ok(cookie !== null);
  return { cookie, wallet };
}

/** "Forgot password?" on this browser: the RECOVER text for (username, wallet) signed by `signer` (normally the wallet),
 *  then the recovery. A refused RECOVER text is answered as it came. */
async function recover(port: number, cookie: string, input: { username: string; wallet: KeplrAccount; signer?: KeplrAccount; newPassword?: string }): Promise<ApiAnswer> {
  const minted = await post(port, "/gs/api/account/authorization", cookie, { purpose: "recover", username: input.username, wallet: input.wallet.address });
  if (minted.status !== 200) return minted;
  const text = (minted.body?.texts as Array<{ text: string }>)[0].text;
  return post(port, "/gs/api/account/recover", cookie, { operation: minted.body?.operation, ...(input.signer ?? input.wallet).sign(text), newPassword: input.newPassword ?? NEW_PASSWORD });
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

  test("a new password (change, forgot password) meets the same floor; a sign-in never re-judges a password the account already has", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      assert.deepEqual((await changePassword(port, ann.cookie, { currentPassword: PASSWORD, newPassword: "short" })).body, { error: "bad-password", problem: "too-short" });
      assert.deepEqual((await recover(port, await bootstrapCookie(port), { username: "ann", wallet: ann.wallet, newPassword: "elevenchars" })).body, { error: "bad-password", problem: "too-short" });
      /* PHASE 3 FINAL: the recovery-key reset this test used to call is retired. */
      const reset = await post(port, "/gs/api/account/reset", await bootstrapCookie(port), { recoveryKey: `${mintRecoverySelector()}.${mintSecret()}`, newPassword: "elevenchars" });
      assert.deepEqual([reset.status, reset.body], [410, { error: "retired" }]);
      assert.equal((await login(port, await bootstrapCookie(port), "ann", PASSWORD)).status, 200, "nothing changed");
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    B. NO RECOVERY KEY (PHASE 3 FINAL -- replaced P3-ACCT POLICY's "one key, shown once")
   ================================================================== */

describe("account policy B: no recovery key exists -- none made, shown, stored or accepted", () => {
  test("create answers no key (the profile holds the SEALED digest); no later answer carries anything private; routine login, Host and Join never ask for the Authorization Wallet", async () => {
    const records = createMemoryRecordStore();
    const { server, port, clock, service } = await prodServer({ records });
    try {
      const before = await bootstrapCookie(port);
      const created = await create(port, before, { username: "Hana", password: PASSWORD, name: "Hana" });
      assert.equal(created.status, 201, created.text);
      assert.deepEqual(Object.keys(created.body as object).sort(), ["ok", "profile", "username"], "no key in the one answer");
      assert.ok(!PRIVATE.test(created.text), created.text);
      assert.equal(created.headers["cache-control"], "no-store");
      const cookie = cookieFromAnswer(created) as string;
      const principal = principalOf(service, cookie, clock.now) as string;
      const profile = service.peekProfileOf(principal) as Profile;
      assert.equal(profile.schema, 3);
      assert.equal(hasRecoveryKey(profile), false, "the sealed digest: no key can match it");
      assert.equal(profile.recovery_hash, sealedRecoveryDigest(profile.recovery_selector));
      /* Nothing else ever answers it either (the credential epoch is internal). */
      for (const answer of [await session(port, cookie), await post(port, "/gs/api/account/me", cookie), await post(port, "/gs/api/trust/me", cookie)]) {
        assert.ok(!answer.text.includes(profile.recovery_selector), answer.text);
        assert.ok(!PRIVATE.test(answer.text), answer.text);
      }
      /* Routine play: Host on this browser, and a subsequent login + Join elsewhere -- username and password only. */
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

  test("every recovery-key route answers 410 retired (nothing is read, nobody is signed in); Confirm it's you takes only the password -- a key field is no field of it", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      const fresh = await bootstrapCookie(port);
      const key = `${mintRecoverySelector()}.${mintSecret()}`;
      for (const [pathname, body] of [
        ["/gs/api/profile/recover", { recoveryKey: key }],
        ["/gs/api/account/reset", { recoveryKey: key, newPassword: NEW_PASSWORD }],
        ["/gs/api/profile/recovery-key", {}],
        ["/gs/api/profile/key-received", {}],
        ["/gs/api/account/credentials", { username: "Ann2", password: PASSWORD }],
      ] as const) {
        for (const cookie of [fresh, ann.cookie]) {
          const answer = await post(port, pathname, cookie, body);
          assert.deepEqual([answer.status, answer.body], [410, { error: "retired" }], pathname);
          assert.equal(cookieFromAnswer(answer), null, "no session issued");
        }
      }
      assert.equal(((await session(port, fresh)).body as { profile: unknown }).profile, null, "this browser is still a visitor");
      const keyed = await post(port, "/gs/api/profile/reauth", ann.cookie, { recoveryKey: key });
      assert.deepEqual([keyed.status, keyed.body], [400, { error: "bad-request" }], "a key makes no grant: it is not even a field");
      assert.equal((await post(port, "/gs/api/profile/reauth", ann.cookie, { password: PASSWORD, recoveryKey: key })).status, 400);
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    C. CHANGE PASSWORD
   ================================================================== */

describe("account policy C: change password", () => {
  test("a wrong current password (or another account's) changes nothing; the current password is the one credential", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      await account(port, "Bea", "bea's own passphrase");
      const principal = principalOf(service, ann.cookie, clock.now) as string;
      const hashBefore = loginOf(service.peekProfileOf(principal) as Profile)?.hash;
      for (const currentPassword of ["not the password", "bea's own passphrase", ""]) {
        const refused = await changePassword(port, ann.cookie, { currentPassword, newPassword: NEW_PASSWORD });
        assert.deepEqual([refused.status, refused.body], [403, { error: "invalid-credential" }], currentPassword);
        assert.equal(cookieFromAnswer(refused), null);
      }
      /* PHASE 3 FINAL: a recovery key is no credential here (no field for one -- the closed body refuses it). */
      assert.equal((await changePassword(port, ann.cookie, { recoveryKey: `${mintRecoverySelector()}.${mintSecret()}`, newPassword: NEW_PASSWORD })).status, 400);
      assert.equal((await changePassword(port, ann.cookie, { currentPassword: PASSWORD, recoveryKey: "rk_x", newPassword: NEW_PASSWORD })).status, 400);
      assert.equal((await changePassword(port, ann.cookie, { newPassword: NEW_PASSWORD })).status, 400, "never without the current password");
      assert.equal(loginOf(service.peekProfileOf(principal) as Profile)?.hash, hashBefore, "the password is unchanged");
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
      assert.deepEqual((boot.body as { profile: unknown }).profile, { name: "Ann", otherSessions: 0, username: "Ann" }, "still signed in, alone");
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

  /* "the recovery key changes it too" is gone with the key: a player who forgot the password signs out and uses "Forgot
     password?" with the Authorization Wallet (D) -- a signed-in browser is refused there (409 already-profiled). */

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

  test("the Authorization Wallet, the credential epoch, the seats and the profile survive a password change; only the other devices' standing ends", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      const phone = await loginOnFreshBrowser(port, "ann", PASSWORD);
      const principal = principalOf(service, ann.cookie, clock.now) as string;
      const mine = service.securityContextOf(readSessionCookie(ann.cookie), clock.now);
      const theirs = service.securityContextOf(readSessionCookie(phone.cookie as string), clock.now);
      assert.ok(mine !== null && theirs !== null);
      const designated = service.authorizationWallet(principal);
      assert.equal(designated?.address, ann.wallet.address);
      const client = await Client.openWithCookie(port, ann.cookie, "ann");
      const table = await client.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "" });
      assert.equal(table.ok, true);
      const profileBefore = service.peekProfileOf(principal) as Profile;
      const changed = await changePassword(port, ann.cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      assert.equal(changed.status, 200);
      await client.closed;
      const profileAfter = service.peekProfileOf(principal) as Profile;
      assert.deepEqual(service.authorizationWallet(principal), designated, "the Authorization Wallet is kept");
      const kept = (profile: Profile) => [profile.profile_id, profile.principal_id, profile.display_name, profile.created_at, profile.login_key, profile.recovery_selector, profile.recovery_hash, profile.wallet_address, profile.wallet_verified_at];
      assert.deepEqual(kept(profileAfter), kept(profileBefore), "identity, username, Authorization Wallet and credential epoch untouched");
      assert.notEqual(profileAfter.password_hash, profileBefore.password_hash);
      assert.deepEqual(service.securityStanding(mine), { kind: "standing" }, "this device's credentials keep standing (same family, same epoch)");
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

  test("security review L5: password changes are budgeted per ACCOUNT (a success's fresh session does not start a fresh budget)", async () => {
    const service = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: POLICY });
    const clock = { now: Date.now() };
    const started = await startServer({
      identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, now: () => clock.now, service },
      limits: { identity: { passwordChangesPerAccount: { capacity: 2, refillPerSecond: 0.000001 } } },
    });
    try {
      const made = await account(started.port, "Ann");
      let cookie = made.cookie;
      /* Malformed requests (a recovery-key field: no such credential) are refused before any budget is spent. */
      for (let n = 0; n < 3; n += 1) {
        assert.equal((await changePassword(started.port, cookie, { recoveryKey: `${mintRecoverySelector()}.${mintSecret()}`, newPassword: NEW_PASSWORD })).status, 400);
      }
      const passwords = [PASSWORD, "second passphrase", "third passphrase!"];
      for (let n = 0; n < 2; n += 1) {
        const changed = await changePassword(started.port, cookie, { currentPassword: passwords[n], newPassword: passwords[n + 1] });
        assert.equal(changed.status, 200, changed.text);
        cookie = cookieFromAnswer(changed) as string;
      }
      const third = await changePassword(started.port, cookie, { currentPassword: passwords[2], newPassword: "fourth passphrase" });
      assert.equal(third.status, 429, "the account's budget is spent, whatever session asks");
      assert.equal((await login(started.port, await bootstrapCookie(started.port), "ann", passwords[2])).status, 200, "nothing changed");
    } finally {
      await stopServer(started.server);
    }
  });

  /* "a profile with no password (made before accounts) is told to set one instead" is gone with the migration: a legacy
     profile is retired (G). */
});

/* ==================================================================
    D. FORGOT PASSWORD (PHASE 3 FINAL: by the Authorization Wallet -- replaced the recovery-key reset)
   ================================================================== */

describe("account policy D: forgot password (the Authorization Wallet, no email, no key)", () => {
  test("the account's Authorization Wallet recovers: every earlier session ends (sockets 4401), this browser is signed in fresh, old password dead, new live; the Authorization Wallet and the credential epoch are kept", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      const phone = await loginOnFreshBrowser(port, "ann", PASSWORD);
      const principal = principalOf(service, ann.cookie, clock.now) as string;
      const profileBefore = service.peekProfileOf(principal) as Profile;
      const sockets = [await Client.openWithCookie(port, ann.cookie, "ann"), await Client.openWithCookie(port, phone.cookie as string, "phone")];
      const browser = await bootstrapCookie(port);
      const done = await recover(port, browser, { username: "ann", wallet: ann.wallet, newPassword: NEW_PASSWORD });
      assert.equal(done.status, 200, done.text);
      assert.deepEqual(done.body, { ok: true, profile: { name: "Ann" }, signedOut: 2 });
      assert.ok(!PRIVATE.test(done.text));
      const fresh = cookieFromAnswer(done) as string;
      assert.ok(fresh !== null && fresh !== browser);
      for (const socket of sockets) assert.equal(await socket.closed, 4401);
      for (const old of [ann.cookie, phone.cookie as string]) assert.deepEqual((await session(port, old)).body, { error: "session-ended", reason: "signed-out-remotely" });
      assert.deepEqual((await session(port, browser)).body, { error: "session-ended", reason: "replaced" }, "the visitor cookie the recovery was made from opens nothing (fixation)");
      assert.deepEqual(((await session(port, fresh)).body as { profile: unknown }).profile, { name: "Ann", otherSessions: 0, username: "Ann" });
      assert.equal(principalOf(service, fresh, clock.now), principal, "the same account and seats");
      assert.equal((await login(port, await bootstrapCookie(port), "ann", PASSWORD)).status, 403, "the old password stops working");
      assert.equal((await login(port, await bootstrapCookie(port), "ann", NEW_PASSWORD)).status, 200);
      const profileAfter = service.peekProfileOf(principal) as Profile;
      assert.deepEqual([profileAfter.wallet_address, profileAfter.wallet_verified_at], [profileBefore.wallet_address, profileBefore.wallet_verified_at], "the Authorization Wallet is kept (it is the recovery authority)");
      assert.deepEqual([profileAfter.recovery_selector, profileAfter.recovery_hash], [profileBefore.recovery_selector, profileBefore.recovery_hash], "the credential epoch is unchanged");
    } finally {
      await stopServer(server);
    }
  });

  /* "security review M2: a reset forgets the verified wallet" is gone by design: no profile wallet is persisted, so there
     is nothing to forget (p3AccountWallet C: linking a seat's wallet never writes the account). */

  test("a wrong proof gets ONE answer whatever is wrong -- another wallet, another key's signature, an unknown username -- and the RECOVER text is minted without looking anything up, so nothing is enumerated", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      const mallory = keplrAccount("policy/mallory");
      /* The RECOVER text says nothing about the username: a real one and an unknown one mint alike. */
      const real = await post(port, "/gs/api/account/authorization", await bootstrapCookie(port), { purpose: "recover", username: "ann", wallet: ann.wallet.address });
      const unknown = await post(port, "/gs/api/account/authorization", await bootstrapCookie(port), { purpose: "recover", username: "nobody", wallet: ann.wallet.address });
      assert.deepEqual([real.status, unknown.status], [200, 200]);
      assert.deepEqual(Object.keys(real.body as object).sort(), Object.keys(unknown.body as object).sort());
      assert.equal((real.body?.texts as unknown[]).length, (unknown.body?.texts as unknown[]).length);
      const answers: ApiAnswer[] = [];
      for (const input of [
        { username: "ann", wallet: mallory },
        { username: "ann", wallet: ann.wallet, signer: mallory },
        { username: "nobody", wallet: ann.wallet },
        { username: "nobody", wallet: mallory },
      ]) {
        answers.push(await recover(port, await bootstrapCookie(port), input));
      }
      for (const answer of answers) {
        assert.deepEqual([answer.status, answer.body], [403, { error: "invalid-credential" }]);
        assert.equal(cookieFromAnswer(answer), null);
      }
      assert.equal(new Set(answers.map(observable)).size, 1, "status, headers and body identical");
      assert.equal((await login(port, await bootstrapCookie(port), "ann", PASSWORD)).status, 200, "nothing changed");
      /* The recovery itself is a closed body: the operation names the account (no username field, and no key). */
      const visitor = await bootstrapCookie(port);
      const minted = await post(port, "/gs/api/account/authorization", visitor, { purpose: "recover", username: "ann", wallet: ann.wallet.address });
      const signed = ann.wallet.sign((minted.body?.texts as Array<{ text: string }>)[0].text);
      for (const extra of [{ username: "ann" }, { recoveryKey: `${mintRecoverySelector()}.${mintSecret()}` }]) {
        assert.equal((await post(port, "/gs/api/account/recover", visitor, { operation: minted.body?.operation, ...signed, newPassword: NEW_PASSWORD, ...extra })).status, 400);
      }
    } finally {
      await stopServer(server);
    }
  });

  test("PHASE 4: 'Forgot current password?' while signed in -- its OWN account only, by its Authorization Wallet only; this browser stays signed in, every other device is signed out", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      const bea = await account(port, "Bea");
      // Never another account's: the RECOVER text is not even minted for it.
      assert.deepEqual((await recover(port, ann.cookie, { username: "bea", wallet: bea.wallet })).body, { error: "already-profiled" });
      // Never the session alone: no operation, a forged one, or another wallet's signature -- one answer.
      const forged = await post(port, "/gs/api/account/recover", ann.cookie, { operation: "0".repeat(32), ...ann.wallet.sign("x"), newPassword: NEW_PASSWORD });
      assert.deepEqual([forged.status, forged.body], [403, { error: "invalid-credential" }]);
      const mallory = keplrAccount("policy/mallory-signed-in");
      assert.equal((await recover(port, ann.cookie, { username: "ann", wallet: mallory })).status, 403, "a wallet that is not Ann's Authorization Wallet");
      assert.equal((await recover(port, ann.cookie, { username: "ann", wallet: ann.wallet, signer: mallory })).status, 403, "Ann's wallet named, another one signing");
      assert.equal((await login(port, await bootstrapCookie(port), "ann", PASSWORD)).status, 200, "nothing changed so far");
      // Another device signed in to Ann.
      const other = await login(port, await bootstrapCookie(port), "ann", PASSWORD);
      const otherCookie = cookieFromAnswer(other) as string;
      // The right wallet: no old password, no sign-out first.
      const reset = await recover(port, ann.cookie, { username: "ann", wallet: ann.wallet });
      assert.equal(reset.status, 200, reset.text);
      assert.equal((reset.body as { signedOut: number }).signedOut >= 1, true);
      const fresh = cookieFromAnswer(reset);
      assert.ok(fresh !== null, "this browser gets a fresh cookie and stays signed in");
      assert.equal((await post(port, "/gs/api/account/me", fresh as string, {})).status, 200);
      assert.equal((await post(port, "/gs/api/account/me", otherCookie, {})).status, 401, "the other device is signed out");
      assert.equal((await login(port, await bootstrapCookie(port), "ann", PASSWORD)).status, 403, "the forgotten password is dead");
      assert.equal((await login(port, await bootstrapCookie(port), "ann", NEW_PASSWORD)).status, 200, "the new one signs in");
      // Single use: the same operation is never answered twice.
      const minted = await post(port, "/gs/api/account/authorization", fresh as string, { purpose: "recover", username: "ann", wallet: ann.wallet.address });
      const text = (minted.body?.texts as Array<{ text: string }>)[0].text;
      const signed = ann.wallet.sign(text);
      assert.equal((await post(port, "/gs/api/account/recover", fresh as string, { operation: minted.body?.operation, ...signed, newPassword: "a third passphrase here" })).status, 200);
      const replay = await post(port, "/gs/api/account/recover", fresh as string, { operation: minted.body?.operation, ...signed, newPassword: "a fourth passphrase here" });
      assert.notEqual(replay.status, 200, "replay refused");
    } finally {
      await stopServer(server);
    }
  });

  test("wrong wallets spend the address's failure budget; the right wallet still recovers", async () => {
    const service = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: POLICY });
    const clock = { now: Date.now() };
    const started = await startServer({
      identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, now: () => clock.now, service },
      limits: { identity: { credentialRedeemsPerIp: { capacity: 2, refillPerSecond: 0.000001 } } },
    });
    try {
      const ann = await account(started.port, "Ann");
      const mallory = keplrAccount("policy/mallory");
      const statuses: number[] = [];
      for (let n = 0; n < 4; n += 1) statuses.push((await recover(started.port, await bootstrapCookie(started.port), { username: "ann", wallet: mallory })).status);
      assert.deepEqual(statuses, [403, 403, 429, 429], "spent");
      assert.equal((await recover(started.port, await bootstrapCookie(started.port), { username: "ann", wallet: ann.wallet })).status, 200, "the right wallet is never stopped by it");
    } finally {
      await stopServer(started.server);
    }
  });
});

/* ==================================================================
    E. CHANGING THE AUTHORIZATION WALLET (PHASE 3 FINAL -- replaced the recovery-key rotation)
   ================================================================== */

describe("account policy E: a new Authorization Wallet", () => {
  test("needs an explicit Confirm it's you (the password) -- never the sign-in's grant; both wallets sign; the old wallet stops recovering at once; the new one recovers; one Authorization Wallet at a time", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      const ann = await account(port, "Ann");
      const principal = principalOf(service, ann.cookie, clock.now) as string;
      const next = keplrAccount("policy/ann-next");
      const challenge = () => post(port, "/gs/api/account/authorization-wallet/challenge", ann.cookie, { newWallet: next.address });
      assert.deepEqual((await challenge()).body, { error: "reauth-required" }, "the sign-in's own grant is not enough");
      assert.equal((await reauth(port, ann.cookie, PASSWORD)).status, 200);
      const minted = await challenge();
      assert.equal(minted.status, 200, minted.text);
      const texts = minted.body?.texts as Array<{ purpose: string; signer: string; text: string }>;
      assert.deepEqual(texts.map((text) => [text.purpose, text.signer]), [
        ["REPLACE-APPROVE", ann.wallet.address],
        ["REPLACE-ACCEPT", next.address],
      ]);
      const approve = ann.wallet.sign(texts[0].text);
      const accept = next.sign(texts[1].text);
      const replaced = await post(port, "/gs/api/account/authorization-wallet/replace", ann.cookie, {
        operation: minted.body?.operation,
        approvePubKey: approve.pubKey,
        approveSignature: approve.signature,
        acceptPubKey: accept.pubKey,
        acceptSignature: accept.signature,
      });
      assert.equal(replaced.status, 200, replaced.text);
      assert.equal((replaced.body as { authorizationWallet: { address: string } }).authorizationWallet.address, next.address);
      assert.equal(service.authorizationWallet(principal)?.address, next.address, "one Authorization Wallet: the new one");
      assert.equal((service.peekProfileOf(principal) as Profile).wallet_address, next.address);
      assert.deepEqual((await recover(port, await bootstrapCookie(port), { username: "ann", wallet: ann.wallet })).body, { error: "invalid-credential" }, "the old wallet no longer recovers");
      assert.equal((await recover(port, await bootstrapCookie(port), { username: "ann", wallet: next })).status, 200, "the new one does");
    } finally {
      await stopServer(server);
    }
  });

  test("across a restart (OD-5-4): an explicit Confirm it's you is reloaded and still begins a replacement; a sign-in's automatic grant is memory only and does not", async () => {
    const store = createMemoryIdentityStore();
    const grantStore = createMemoryGrantStore();
    const clock = { now: Date.now() };
    const options = { policy: POLICY, security: { grants: grantStore, clock: () => clock.now } };
    const first = await IdentityService.open(store, options);
    const a = await prodServer({ service: first });
    let confirmed: string;
    let signedIn: string;
    try {
      confirmed = (await account(a.port, "Ann")).cookie;
      assert.equal((await reauth(a.port, confirmed, PASSWORD)).status, 200);
      signedIn = (await account(a.port, "Bea")).cookie;
    } finally {
      await stopServer(a.server);
    }
    assert.equal((await grantStore.live(clock.now)).length, 1, "only the confirmation was written");
    const second = await IdentityService.open(store, options);
    assert.equal(second.hasSensitiveAuth(readSessionCookie(signedIn), clock.now), false, "the sign-in's grant did not survive");
    assert.equal(second.hasSensitiveAuth(readSessionCookie(confirmed), clock.now), true, "the confirmation did");
    const newWallet = keplrAccount("policy/after-restart").address;
    assert.equal(second.mintReplacement(readSessionCookie(confirmed), { newWallet, site: TEST_SITE }, clock.now).kind, "ok");
    assert.equal(second.mintReplacement(readSessionCookie(signedIn), { newWallet, site: TEST_SITE }, clock.now).kind, "reauth-required");
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
  test("a STALE second writer (its view predates a recovery) cannot write its own recovery over it: the store refuses the superseded password generation", async () => {
    const store = createMemoryIdentityStore();
    const now = Date.now();
    const wallet = walletFor("fence-ann");
    const a = IdentityService.fromSnapshot(store, { principals: [], sessions: [] }, { policy: POLICY });
    const made = await createAccountWith(a, await guestOf(a, now), { username: "Ann", password: PASSWORD, displayName: "Ann", wallet }, now);
    assert.equal(made.kind, "ok");
    /* Every session ends first (so only the password generation can stand between the two writers). */
    await a.revoke((made as { sessionId: string }).sessionId, "logout", now);
    const b = IdentityService.fromSnapshot(store, store.snapshot(), { policy: POLICY });
    const first = await recoverWith(a, await guestOf(a, now), { username: "Ann", wallet, newPassword: NEW_PASSWORD }, now);
    assert.equal(first.kind, "ok");
    const stale = await recoverWith(b, await guestOf(b, now), { username: "Ann", wallet, newPassword: "the stale writer's passphrase" }, now);
    assert.equal(stale.kind, "unavailable", "refused by the store (profile-password), nothing written");
    const durable = store.snapshot().profiles[0];
    assert.equal(await verifyPassword(NEW_PASSWORD, loginOf(durable)?.hash ?? null, TEST_PASSWORD_KDF), true, "the first recovery stands");
    /* The store's own contract, directly: a change pinned to a superseded hash is DEFINITE, nothing written. */
    const superseded = await hashPassword("x".repeat(12), TEST_PASSWORD_KDF);
    await assert.rejects(store.commit({ expect: [{ kind: "profile-password", profile_id: durable.profile_id, password_hash: superseded }], profiles: [{ ...durable, display_name: "Renamed" }] }), StoreDefiniteError);
  });

  test("a recovery racing a password change: whichever lands second is refused (the generation it checked is gone)", async () => {
    const now = Date.now();
    /* A security journal whose append can be held: the change is held INSIDE its commit (journal first), so the recovery
       checks the wallet and the password generation before the change lands, and reaches the queue after it. */
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
    const service = IdentityService.fromSnapshot(store, { principals: [], sessions: [] }, { policy: POLICY, security: { journal } });
    const wallet = walletFor("race-ann");
    const made = await createAccountWith(service, await guestOf(service, now), { username: "Ann", password: PASSWORD, displayName: "Ann", wallet }, now);
    const read = cookieRead((made as { setCookie: string }).setCookie.split(";")[0]);
    const visitor = await guestOf(service, now);
    let release: () => void = () => undefined;
    hold = new Promise<void>((resolve) => (release = resolve));
    const changing = service.changePassword(read, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, now);
    await inside; // the change is committing (its event is being appended), not yet applied
    const recovering = recoverWith(service, visitor, { username: "Ann", wallet, newPassword: "the other passphrase" }, now);
    await sleep(30); // the recovery's checks (and its KDF) run now, against the generation the change is replacing
    release();
    const [changed, recovered] = await Promise.all([changing, recovering]);
    assert.equal(changed.kind, "ok");
    assert.equal(recovered.kind, "invalid", "the generation the recovery checked is gone");
    assert.equal(service.stats.accountRecoveries, 0);
    assert.equal(await verifyPassword(NEW_PASSWORD, loginOf(store.snapshot().profiles[0])?.hash ?? null, TEST_PASSWORD_KDF), true);
  });

  test("two devices changing at once: one wins; the other is signed out by it and changes nothing", async () => {
    const now = Date.now();
    const service = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: POLICY });
    const made = await createAccountWith(service, await guestOf(service, now), { username: "Ann", password: PASSWORD, displayName: "Ann", wallet: walletFor("two-ann") }, now);
    const laptop = cookieRead((made as { setCookie: string }).setCookie.split(";")[0]);
    const signedIn = await service.login(await guestOf(service, now), { username: "ann", password: PASSWORD }, now);
    const phone = cookieRead((signedIn as { setCookie: string }).setCookie.split(";")[0]);
    const results = await Promise.all([
      service.changePassword(laptop, { currentPassword: PASSWORD, newPassword: "laptop's new passphrase" }, now),
      service.changePassword(phone, { currentPassword: PASSWORD, newPassword: "phone's new passphrase" }, now),
    ]);
    assert.deepEqual(results.map((result) => result.kind).sort(), ["not-authenticated", "ok"]);
    assert.equal(service.stats.passwordChanges, 1);
  });

  test("the journal replay never brings an old password back: an identity restored to before the change installs the chain's head", async () => {
    const now = Date.now();
    const store = createMemoryIdentityStore();
    const journal = createMemorySecurityJournal();
    const service = IdentityService.fromSnapshot(store, { principals: [], sessions: [] }, { policy: POLICY, security: { journal } });
    const wallet = walletFor("replay-ann");
    const made = await createAccountWith(service, await guestOf(service, now), { username: "Ann", password: PASSWORD, displayName: "Ann", wallet }, now);
    const read = cookieRead((made as { setCookie: string }).setCookie.split(";")[0]);
    await service.settled();
    const restorePoint = store.snapshot(); // T: the first password
    const changed = await service.changePassword(read, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, now + 1);
    assert.equal(changed.kind, "ok");
    const third = "the third passphrase";
    assert.equal((await recoverWith(service, await guestOf(service, now + 2), { username: "Ann", wallet, newPassword: third }, now + 2)).kind, "ok");
    await service.settled();
    const events = journal.snapshot().map((body) => parseSecurityEventBody(body) as SecurityEvent);
    const replacements = events.filter((event): event is Extract<SecurityEvent, { kind: "password-replaced" }> => event.kind === "password-replaced");
    assert.deepEqual(replacements.map((event) => event.via), ["password", "authorization-wallet"], "a change, then a recovery by the Authorization Wallet");
    assert.ok(events.every((event) => !JSON.stringify(event).includes(PASSWORD) && !JSON.stringify(event).includes(NEW_PASSWORD) && !JSON.stringify(event).includes(third)), "hashes only -- no password");
    const plan = planSecurityReplay({ snapshot: restorePoint, events, restoreId: "rs-test", at: now + 10 });
    assert.equal(plan.report.passwords_advanced, 1);
    let restored = restorePoint;
    for (const entry of plan.principals) if (entry.change !== null) restored = applyChange(restored, entry.change);
    const hash = loginOf(restored.profiles[0])?.hash ?? null;
    assert.equal(await verifyPassword(PASSWORD, hash, TEST_PASSWORD_KDF), false, "the first password never comes back");
    assert.equal(await verifyPassword(NEW_PASSWORD, hash, TEST_PASSWORD_KDF), false, "nor the second");
    assert.equal(await verifyPassword(third, hash, TEST_PASSWORD_KDF), true, "the latest one is installed");
    assert.equal(restored.profiles[0].wallet_address, wallet.address, "the Authorization Wallet is untouched by the password chain");
    const pinned = plan.principals.flatMap((entry) => entry.change?.expect ?? []).find((condition) => condition.kind === "profile-password");
    assert.ok(pinned !== undefined, "the replay pins the password the table holds");
    /* Idempotent: a second run plans nothing more for the password. */
    assert.equal(planSecurityReplay({ snapshot: restored, events, restoreId: "rs-test", at: now + 10 }).report.passwords_advanced, 0);
    /* Confirmations lost: the last replacement from each password is still followed (the Authorization Wallet is the
       remedy for a wrong guess). */
    const unconfirmed = events.filter((event) => event.kind !== "confirmed");
    const guessed = planSecurityReplay({ snapshot: restorePoint, events: unconfirmed, restoreId: "rs-test", at: now + 10 });
    let restored2 = restorePoint;
    for (const entry of guessed.principals) if (entry.change !== null) restored2 = applyChange(restored2, entry.change);
    assert.equal(await verifyPassword(third, loginOf(restored2.profiles[0])?.hash ?? null, TEST_PASSWORD_KDF), true);
  });

  /* "security review M1: a migrated legacy profile that later changed its password restores" is gone with the legacy
     migration (a legacy profile is retired, G). The replay still reads journals written before this build
     (securityReplay.ts); p3AccountWallet's restore test pins a legacy `credentials-established`. */

  test("the replay is strict: a cycle of replacements, or a table password the journal never names, is refused (fail closed)", async () => {
    const now = Date.now();
    const store = createMemoryIdentityStore();
    const service = IdentityService.fromSnapshot(store, { principals: [], sessions: [] }, { policy: POLICY });
    await createAccountWith(service, await guestOf(service, now), { username: "Ann", password: PASSWORD, displayName: "Ann", wallet: walletFor("strict-ann") }, now);
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
    G. LEGACY PROFILES -- RETIRED (PHASE 3 FINAL: replaced "legacy profiles keep their key; migration still works")
   ================================================================== */

const DAY = 24 * 60 * 60 * 1000;

/** A LEGACY profile as a restart finds it -- schema 1 (a recovery-key profile) or, with `login`, schema 2 (a username and
 *  password, but no Authorization Wallet) -- with one live session whose cookie the test holds. */
function legacyAccount(now: number, n: number, login: string | null, passwordHash: string) {
  const principalId = mintPrincipalId();
  const profileId = mintProfileId();
  const sessionId = mintSessionId();
  const secret = mintSecret();
  const principal: Principal = { principal_id: principalId, kind: "profile", status: "active", created_at: now - DAY, activated_at: now - DAY, last_seen_at: now - DAY, account_link: profileId };
  const base = { profile_id: profileId, principal_id: principalId, display_name: `Old ${n}`, created_at: now - DAY, status: "active" as const, recovery_selector: mintRecoverySelector(), recovery_hash: secretHash(mintSecret()), recovery_rotated_at: now - DAY };
  const profile: Profile =
    login === null
      ? { ...base, schema: 1 }
      : { ...base, schema: 2, login_key: loginKeyOf(login), login_name: login, password_hash: passwordHash, password_set_at: now - DAY, wallet_address: null, wallet_verified_at: null };
  const session: Session = { session_id: sessionId, principal_id: principalId, secret_hash: secretHash(secret), created_at: now - 1000, last_seen_at: now - 1000, expires_at: now + 29 * DAY, revoked_at: null, revoke_reason: null, rotated_to: null, family_id: familyIdOf(sessionId) };
  const family: SessionFamily = { family_id: session.family_id, principal_id: principalId, created_at: now - 1000, origin: "bootstrap", revoked_at: null, revoke_reason: null };
  return { principal, profile, session, family, cookie: `__Host-gs_session=v1.${sessionId}.${secret}` };
}

/** The status of a production socket upgrade; an accepted socket is closed at once. */
function upgradeStatus(port: number, cookie: string): Promise<number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/gs`, { headers: { Cookie: cookie }, origin: PROD_ORIGIN });
    socket.on("error", () => undefined);
    socket.once("open", () => {
      socket.terminate();
      resolve(101);
    });
    socket.once("unexpected-response", (req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
      req.destroy();
    });
  });
}

describe("account policy G: legacy profiles (made before Authorization Wallets) are retired -- no migration", () => {
  test("a legacy session ends `retired`; the legacy account's RIGHT password answers 409 legacy-account (a wrong one is the one invalid answer); nothing migrates or recovers it", async () => {
    const now = Date.now();
    const hash = await hashPassword(PASSWORD, TEST_PASSWORD_KDF);
    const keyed = legacyAccount(now, 1, null, hash);
    const named = legacyAccount(now, 2, "OldTimer", hash);
    const store = createMemoryIdentityStore({
      principals: [keyed.principal, named.principal],
      sessions: [keyed.session, named.session],
      profiles: [keyed.profile, named.profile],
      links: [],
      families: [keyed.family, named.family],
    });
    const service = IdentityService.fromSnapshot(store, store.snapshot(), { policy: POLICY });
    const { server, port } = await prodServer({ service });
    try {
      for (const legacy of [keyed, named]) {
        assert.equal(service.isProfiled(legacy.principal.principal_id), false, "retired");
        const boot = await session(port, legacy.cookie);
        assert.deepEqual([boot.status, boot.body], [401, { error: "session-ended", reason: "retired" }], "ended -- never a silent new guest");
        assert.equal(await upgradeStatus(port, legacy.cookie), 401);
        assert.deepEqual((await changePassword(port, legacy.cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).body, { error: "not-authenticated" });
        assert.deepEqual((await reauth(port, legacy.cookie, PASSWORD)).body, { error: "not-authenticated" });
      }
      /* The RIGHT password of the legacy account: told so -- only its holder learns it -- and nothing is signed in. */
      const right = await loginOnFreshBrowser(port, "oldtimer", PASSWORD);
      assert.deepEqual([right.answer.status, right.answer.body], [409, { error: "legacy-account" }]);
      assert.equal(right.cookie, null);
      assert.equal(((await session(port, right.before)).body as { profile: unknown }).profile, null, "this browser is still a visitor");
      /* A wrong password is exactly an unknown username's answer. */
      const wrong = await loginOnFreshBrowser(port, "oldtimer", "not the password");
      const unknown = await loginOnFreshBrowser(port, "nobody", PASSWORD);
      assert.deepEqual([wrong.answer.status, wrong.answer.body], [403, { error: "invalid-credential" }]);
      assert.equal(observable(wrong.answer), observable(unknown.answer));
      /* Nothing migrates it: the credential, recovery-key and reset routes are retired; no wallet recovers it. */
      for (const [pathname, body] of [
        ["/gs/api/account/credentials", { username: "OldTimer", password: PASSWORD }],
        ["/gs/api/profile/recover", { recoveryKey: `${keyed.profile.recovery_selector}.${mintSecret()}` }],
        ["/gs/api/account/reset", { recoveryKey: `${named.profile.recovery_selector}.${mintSecret()}`, newPassword: NEW_PASSWORD }],
      ] as const) {
        assert.deepEqual((await post(port, pathname, await bootstrapCookie(port), body)).body, { error: "retired" }, pathname);
      }
      assert.deepEqual((await recover(port, await bootstrapCookie(port), { username: "oldtimer", wallet: walletFor("oldtimer") })).body, { error: "invalid-credential" });
      assert.equal(service.stats.legacyRefusals, 1);
      assert.deepEqual(store.snapshot().profiles.map((profile) => profile.schema).sort(), [1, 2], "nothing was migrated");
    } finally {
      await stopServer(server);
    }
  });

  /* "a legacy browser's sign-in by link code never has a grant to establish credentials with" is gone with link codes and
     the credential establishment (both routes answer 410, above and in B). */
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
    profileFacts: (principalId) => (profiles.includes(principalId) ? { createdAt: NOW - 30 * 86_400_000, authorizationWalletSince: NOW - 30 * 86_400_000 } : null),
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
      { record: record([me, "pr_i"]), fin: fin("held") }, // held for an operator: not counted (review NIT 10)
    ];
    const facts = world(tables, [me, "pr_a", "pr_b", "pr_c", "pr_d", "pr_e", "pr_f", "pr_h"]);
    const mine = await facts.factsOf(me);
    assert.equal(mine?.completedMoneyGames, 3, "g1, g2 and g7");
    assert.equal(mine?.establishedOpponents, 2, "pr_a (once, for two games) and pr_b");
    assert.equal(mine?.authorizationWalletSince, "2026-09", "PHASE 3 FINAL: the Authorization Wallet's month, never an address");
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

  test("review L5: an answer computed while a record could not be read is reused only briefly", async () => {
    const me = "pr_me";
    let clock = NOW;
    let readable = false;
    const one = record([me, "pr_y"]);
    const facts = createTrustFacts({
      profileFacts: () => ({ createdAt: NOW, authorizationWalletSince: NOW }),
      tablesOf: () => [one],
      financial: async () => (readable ? fin("closed", "SETTLED") : null),
      now: () => clock,
      reuseMs: 60_000,
    });
    assert.equal((await facts.factsOf(me))?.completedMoneyGames, 0);
    readable = true;
    assert.equal((await facts.factsOf(me))?.completedMoneyGames, 0, "briefly reused (a failing store is not hammered)");
    clock += INCOMPLETE_REUSE_MS;
    assert.equal((await facts.factsOf(me))?.completedMoneyGames, 1, "read again after the short window, not the cached zero");
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
      profileFacts: () => ({ createdAt: NOW, authorizationWalletSince: NOW }), // both made just now
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
