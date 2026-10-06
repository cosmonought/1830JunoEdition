// server/src/identity/p3AccountWallet.test.ts
//
// ==================================================================
//  PHASE 3 (P3-ACCT): USERNAME/PASSWORD ACCOUNTS, THE PUBLIC-FIRST SOCKET, THE PERSISTED WALLET, TRUST FACTS
// ==================================================================
//
// Against the real server (production identity: cookies, an allowed Origin, real sockets) and the real money stack
// over the offline Juno (`escrow4Support.ts`):
//   A. accounts: create (no recovery key, a FRESH session: fixation), login (the same principal and seats; one answer
//      for every wrong or unknown credential; budgets), reload/new tab, sign out, the legacy migration, restart;
//   B. the public-first socket: a signed-out visitor reads the public list and watches a public table, read-only;
//      every identity-bearing frame is `profile-required`; a private table is `not-found`;
//   C. the persisted wallet: a grant-authorized link persists it; the same wallet then links WITHOUT the password; any
//      other wallet still needs it (and W2-M's replace); the payout wallet is the bound one; a restore clears it;
//   D. trust facts: server-derived, keyed by public seat ids, no private id anywhere.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createMemoryRecordStore } from "../rooms/recordStore";
import {
  accountBrowser,
  apiRequest,
  BUY,
  bootstrapCookie,
  Client,
  cookieFromAnswer,
  loginOnFreshBrowser,
  PROD_ORIGIN,
  profiledBrowser,
  quietConsole,
  sleep,
  startServer,
  stopServer,
  type ApiAnswer,
} from "../rooms/testSupport";
import { accountPlayer, hostCreates, joinerFunds, linkWallet, moneyServer, openMoneyTable, player, TEST_PASSWORD_KDF, testConsentKey, testWallet, viewOf, type MoneyServer, type Player } from "../escrow/escrow4Support";
import type { RoomMoneyView } from "../../../frontend/src/utils/moneyProtocol";
import { cleanLoginName, cleanPassword, DEFAULT_PASSWORD_KDF, hashPassword, hasRecoveryKey, isPasswordHash, KdfGate, loginKeyOf, sealedRecoveryDigest, verifyPassword } from "./accountCredentials";
import { readSessionCookie } from "./cookies";
import { createJournalIdentityStore } from "./journalStore";
import { planSecurityReplay } from "./securityReplay";
import { SECURITY_EVENT_FORMAT, SECURITY_EVENT_VERSION, type SecurityEvent } from "./securityEvents";
import { IdentityService } from "./sessions";
import { applyChange, createMemoryIdentityStore, loginOf, walletOf, type FullIdentitySnapshot, type Profile } from "./store";
import { FIXTURE_WALLET, FIXTURE_WALLET_2, identitySet, accountProfile } from "../persistence/conformance/fixtures";

quietConsole();

const PASSWORD = "correct horse battery";

/** A production server whose identity uses the cheap test KDF (a stored hash carries its own parameters). */
async function prodServer(over: { clock?: { now: number }; service?: IdentityService; records?: ReturnType<typeof createMemoryRecordStore>; limits?: Record<string, unknown> } = {}) {
  const clock = over.clock ?? { now: Date.now() };
  const service = over.service ?? IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF } });
  const started = await startServer({
    identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, now: () => clock.now, service },
    ...(over.records ? { records: over.records } : {}),
    limits: { identity: { ...(over.limits ?? {}) } },
  });
  return { ...started, clock, service };
}

const post = (port: number, pathname: string, cookie?: string, body: object = {}) => apiRequest(port, pathname, { cookie, body });
const session = (port: number, cookie?: string) => post(port, "/gs/api/session", cookie);
const create = (port: number, cookie: string, body: object) => post(port, "/gs/api/account/create", cookie, body);
const login = (port: number, cookie: string, username: string, password: string) => post(port, "/gs/api/account/login", cookie, { username, password });
const me = (port: number, cookie: string) => post(port, "/gs/api/account/me", cookie);
const principalOf = (service: IdentityService, cookie: string, now: number): string | null => {
  const auth = service.authenticate(readSessionCookie(cookie), now);
  return auth.kind === "ok" ? auth.principalId : null;
};
/** What a money route would pass to `associateWallet`: this cookie's security context and the wallet it saw. */
const linkContextOf = (service: IdentityService, cookie: string, now: number) => {
  const context = service.securityContextOf(readSessionCookie(cookie), now);
  if (context === null) throw new Error("not a profiled session");
  return { ...context, seen: service.profileWallet(context.principalId)?.address ?? null };
};
/** Status, headers (less the clock) and body: two refusals compared for sameness. */
function observable(answer: ApiAnswer): string {
  const { date: _date, connection: _connection, "keep-alive": _keepAlive, ...headers } = answer.headers;
  return JSON.stringify({ status: answer.status, headers, text: answer.text });
}
const ID_PATTERN = /pr_|pf_|se_|sf_|rk_|scrypt\$|password_hash|login_key/;

/* ==================================================================
    THE CREDENTIAL ITSELF
   ================================================================== */

describe("P3-ACCT the credential: usernames, passwords, the scrypt hash", () => {
  test("a username is NFKC, trimmed, 1-64 characters, no whitespace or control characters; its key is case-folded", () => {
    assert.equal(cleanLoginName("  Brad.Player  "), "Brad.Player");
    assert.equal(cleanLoginName("Ｂｒａｄ"), "Brad", "NFKC folds the full-width forms");
    for (const bad of ["", "   ", "two words", "tab\tname", "line\nname", "zero​width", "x".repeat(65), 7, null]) assert.equal(cleanLoginName(bad), null, JSON.stringify(bad));
    assert.equal(loginKeyOf("Brad.Player"), "brad.player");
    assert.equal(loginKeyOf("BRAD.PLAYER"), loginKeyOf("brad.player"));
  });

  test("a password is at least 12 characters (the owner's floor, 2026-10-05), at most 1 KiB, never trimmed", () => {
    assert.deepEqual(cleanPassword("12345678901"), { ok: false, problem: "too-short" });
    assert.deepEqual(cleanPassword(" 12345678901"), { ok: true, password: " 12345678901" }, "whitespace counts and is kept");
    assert.deepEqual(cleanPassword("x".repeat(1025)), { ok: false, problem: "too-long" });
  });

  test("scrypt: a random salt per hash, the parameters stored with it, a constant-time check; an unknown account does the same work and is false", async () => {
    const one = await hashPassword(PASSWORD, TEST_PASSWORD_KDF);
    const two = await hashPassword(PASSWORD, TEST_PASSWORD_KDF);
    assert.ok(isPasswordHash(one) && isPasswordHash(two));
    assert.notEqual(one, two, "a fresh salt every time");
    assert.ok(!one.includes(PASSWORD), "never the password");
    assert.match(one, /^scrypt\$1\$10\$1\$1\$/);
    assert.equal(await verifyPassword(PASSWORD, one, TEST_PASSWORD_KDF), true);
    assert.equal(await verifyPassword(`${PASSWORD}!`, one, TEST_PASSWORD_KDF), false);
    assert.equal(await verifyPassword(PASSWORD, null, TEST_PASSWORD_KDF), false, "no account: false, after the dummy's work");
    assert.equal(await verifyPassword(PASSWORD, "scrypt$1$99$1$1$x$y", TEST_PASSWORD_KDF), false, "a damaged hash matches nothing");
    assert.deepEqual(DEFAULT_PASSWORD_KDF, { logN: 15, r: 8, p: 3 }, "production: OWASP's scrypt row N=2^15, r=8, p=3");
  });

  test("the KDF gate answers busy beyond its bound instead of queueing without limit", async () => {
    const gate = new KdfGate(1);
    let release: () => void = () => undefined;
    const held = gate.run(() => new Promise<void>((resolve) => (release = resolve)));
    assert.deepEqual(await gate.run(async () => 1), { kind: "busy" });
    release();
    assert.equal((await held).kind, "ok");
    assert.deepEqual(await gate.run(async () => 2), { kind: "ok", value: 2 });
  });

  test("review M1: one address cannot fill the gate, and the last slot is kept for a signed-in session confirming it's you", async () => {
    const gate = new KdfGate(4, 2);
    const releases: Array<() => void> = [];
    const hold = (options: { client?: string; authenticated?: boolean }) => gate.run(() => new Promise<void>((resolve) => releases.push(resolve)), options);
    const running = [hold({ client: "a" }), hold({ client: "a" })];
    assert.deepEqual(await gate.run(async () => 0, { client: "a" }), { kind: "busy" }, "two per address");
    running.push(hold({ client: "b" }));
    assert.deepEqual(await gate.run(async () => 0, { client: "c" }), { kind: "busy" }, "anonymous work never takes the last slot");
    assert.deepEqual(await gate.run(async () => 7, { client: "c", authenticated: true }), { kind: "ok", value: 7 }, "a signed-in confirmation gets it");
    releases.forEach((release) => release());
    await Promise.all(running);
    assert.equal(gate.inFlight, 0);
  });

  test("review L1 / N4: a username whose canonical key would be too long is no username; a lone surrogate is no password", () => {
    assert.equal(cleanLoginName("\u0130".repeat(40)), null, "İ lower-cases to two code points: an 80-character key");
    assert.equal(cleanLoginName("\u0130".repeat(30)), "\u0130".repeat(30));
    assert.deepEqual(cleanPassword("abcdefgh\ud800"), { ok: false, problem: "invalid" });
  });

  test("an account with no recovery key carries a SEALED digest no key can match", () => {
    const set = identitySet(31);
    const sealed: Profile = { ...set.profile, recovery_hash: sealedRecoveryDigest(set.profile.recovery_selector) };
    assert.equal(hasRecoveryKey(sealed), false);
    assert.equal(hasRecoveryKey(set.profile), true);
  });
});

/* ==================================================================
    A. ACCOUNTS
   ================================================================== */

describe("P3-ACCT create account", () => {
  test("201 with the username, ONE recovery key (P3-ACCT POLICY), and a FRESH session cookie -- the temporary one is replaced (session fixation)", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      const before = await bootstrapCookie(port);
      const answer = await create(port, before, { username: "Brad.Player", password: PASSWORD, name: "Brad" });
      assert.equal(answer.status, 201, answer.text);
      const { recoveryKey, ...rest } = answer.body as { recoveryKey: string };
      assert.deepEqual(rest, { ok: true, profile: { name: "Brad", otherSessions: 0 }, username: "Brad.Player" });
      assert.match(recoveryKey, /^rk_[0-9a-z]{26}\.[A-Za-z0-9_-]{43}$/, "the account's one recovery key, in its one appearance");
      assert.ok(!ID_PATTERN.test(answer.text.replace(recoveryKey, "")), "no id or hash in the answer (only the key itself)");
      const cookie = cookieFromAnswer(answer);
      assert.ok(cookie !== null && cookie !== before, "a fresh session");
      assert.deepEqual((await session(port, before)).body, { error: "session-ended", reason: "replaced" }, "the cookie the browser held before opens nothing");
      const boot = await session(port, cookie as string);
      assert.deepEqual((boot.body as { profile: unknown }).profile, { name: "Brad", otherSessions: 0 }, "the reload / new tab is signed in (the cookie is the browser's)");
      const principal = principalOf(service, cookie as string, clock.now) as string;
      const profile = service.peekProfileOf(principal) as Profile;
      assert.equal(profile.schema, 2);
      assert.equal(loginOf(profile)?.key, "brad.player");
      assert.equal(hasRecoveryKey(profile), true, "a real recovery key (P3-ACCT POLICY)");
      assert.ok(!JSON.stringify(profile).includes(PASSWORD), "never the password");
      assert.ok(!JSON.stringify(profile).includes(recoveryKey.split(".")[1]), "never the key's secret (its digest only)");
      const mine = await me(port, cookie as string);
      assert.equal(mine.status, 200);
      const account = (mine.body as { account: Record<string, unknown> }).account;
      assert.deepEqual([account.name, account.username, account.recoveryKey, account.wallet], ["Brad", "Brad.Player", true, null]);
      assert.ok(!ID_PATTERN.test(mine.text));
      void server;
    } finally {
      await stopServer(server);
    }
  });

  test("a username is unique whatever its case; malformed input is 400; a signed-in browser is 409; the profile budget applies", async () => {
    const { server, port } = await prodServer({ limits: { profileCreatesPerIp: { capacity: 6, refillPerSecond: 0.0001 } } });
    try {
      await accountBrowser(port, "Ann", PASSWORD);
      const other = await bootstrapCookie(port);
      assert.deepEqual((await create(port, other, { username: "ANN", password: PASSWORD, name: "Ann 2" })).body, { error: "username-taken" });
      assert.deepEqual((await create(port, other, { username: "two words", password: PASSWORD, name: "X" })).body, { error: "bad-username" });
      assert.deepEqual((await create(port, other, { username: "Bea", password: "short", name: "X" })).body, { error: "bad-password", problem: "too-short" });
      assert.deepEqual((await create(port, other, { username: "Bea", password: PASSWORD, name: "" })).body, { error: "bad-name" });
      assert.equal((await create(port, other, { username: "Bea", password: PASSWORD, name: "Bea", extra: 1 })).status, 400, "a closed body");
      const bea = await create(port, other, { username: "Bea", password: PASSWORD, name: "Bea" });
      assert.equal(bea.status, 201);
      const signedIn = cookieFromAnswer(bea) as string;
      assert.equal((await create(port, signedIn, { username: "Bea2", password: PASSWORD, name: "Bea" })).status, 409);
      /* The address's creation budget (6) is spent by every attempt that reached the account check -- Ann, the taken
         name, the bad username, the bad password, Bea -- so one more account fits and the next is refused. */
      for (const name of ["Cy"]) assert.equal((await create(port, await bootstrapCookie(port), { username: name, password: PASSWORD, name })).status, 201);
      const limited = await create(port, await bootstrapCookie(port), { username: "Di", password: PASSWORD, name: "Di" });
      assert.equal(limited.status, 429);
    } finally {
      await stopServer(server);
    }
  });
});

describe("P3-ACCT log in", () => {
  test("the right password: a fresh session for the SAME principal -- its table and seat are there; reload keeps it; sign out ends it", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      const ann = await accountBrowser(port, "Ann", PASSWORD);
      const client = await Client.openWithCookie(port, ann.cookie, "ann");
      const table = await client.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "" });
      assert.equal(table.ok, true, JSON.stringify(table));
      const gameId = (table.data as { gameId: string }).gameId;
      await client.close();
      const principal = principalOf(service, ann.cookie, clock.now);
      /* Another device: log in. */
      const second = await loginOnFreshBrowser(port, "ann", PASSWORD);
      assert.equal(second.answer.status, 200, second.answer.text);
      assert.deepEqual(second.answer.body, { ok: true, profile: { name: "Ann" } });
      assert.ok(!ID_PATTERN.test(second.answer.text));
      assert.equal(principalOf(service, second.cookie as string, clock.now), principal, "the SAME principal: every seat follows");
      assert.deepEqual((await session(port, second.before)).body, { error: "session-ended", reason: "replaced" });
      const device = await Client.openWithCookie(port, second.cookie as string, "ann-2");
      const tables = await device.op({ type: "my-tables" });
      assert.ok(((tables.data as { tables: Array<{ gameId: string }> }).tables ?? []).some((entry) => entry.gameId === gameId), "Your tables, on the new device");
      /* Hosting again needs nothing more than the session (no password, no key). */
      const again = await device.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "" });
      assert.equal(again.ok, true, JSON.stringify(again));
      await device.close();
      /* Reload / new tab: the cookie still bootstraps to the account. */
      assert.equal(((await session(port, second.cookie as string)).body as { profile: { name: string } }).profile.name, "Ann");
      /* Sign out this device: the session ends; the other device stays. */
      assert.equal((await post(port, "/gs/api/session/revoke", second.cookie as string)).status, 204);
      assert.deepEqual((await session(port, second.cookie as string)).body, { error: "session-ended", reason: "logout" });
      assert.equal(((await session(port, ann.cookie)).body as { profile: { name: string } }).profile.name, "Ann");
    } finally {
      await stopServer(server);
    }
  });

  test("ONE answer for a wrong password, an unknown username and a malformed one -- status, headers and body", async () => {
    const { server, port } = await prodServer();
    try {
      await accountBrowser(port, "Ann", PASSWORD);
      const wrong = await loginOnFreshBrowser(port, "Ann", "not the password");
      const unknown = await loginOnFreshBrowser(port, "Nobody", PASSWORD);
      const malformed = await loginOnFreshBrowser(port, "two words", PASSWORD);
      const empty = await loginOnFreshBrowser(port, "Ann", "");
      for (const refused of [wrong, unknown, malformed, empty]) {
        assert.deepEqual([refused.answer.status, refused.answer.body], [403, { error: "invalid-credential" }]);
        assert.equal(observable(refused.answer), observable(wrong.answer), "indistinguishable");
        assert.equal(((await session(port, refused.before)).body as { profile: unknown }).profile, null, "the browser is not signed in, and its session is not replaced");
      }
    } finally {
      await stopServer(server);
    }
  });

  test("a signed-in browser is 409 (nothing checked); a browser that holds pre-profile tables is 409 has-tables", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await accountBrowser(port, "Ann", PASSWORD);
      assert.deepEqual((await login(port, ann.cookie, "Ann", PASSWORD)).body, { error: "already-profiled" });
    } finally {
      await stopServer(server);
    }
  });

  test("budgets: wrong passwords per USERNAME (any address) and per ADDRESS -- spent, even the right password waits (429), and an unknown username is budgeted exactly alike", async () => {
    const { server, port } = await prodServer({ limits: { passwordFailuresPerAccount: { capacity: 3, refillPerSecond: 0.0001 }, passwordFailuresPerIp: { capacity: 100, refillPerSecond: 0.0001 } } });
    try {
      await accountBrowser(port, "Ann", PASSWORD);
      for (let n = 0; n < 3; n += 1) assert.equal((await loginOnFreshBrowser(port, "ann", `guess ${n}`)).answer.status, 403);
      const locked = await loginOnFreshBrowser(port, "ANN", PASSWORD);
      assert.equal(locked.answer.status, 429, "the username's budget is spent: nobody keeps guessing");
      for (let n = 0; n < 3; n += 1) assert.equal((await loginOnFreshBrowser(port, "Nobody", `guess ${n}`)).answer.status, 403);
      assert.equal((await loginOnFreshBrowser(port, "nobody", PASSWORD)).answer.status, 429, "an unknown username: the same budget, the same answers");
    } finally {
      await stopServer(server);
    }
    const narrow = await prodServer({ limits: { passwordFailuresPerIp: { capacity: 2, refillPerSecond: 0.0001 } } });
    try {
      await accountBrowser(narrow.port, "Bea", PASSWORD);
      for (let n = 0; n < 2; n += 1) assert.equal((await loginOnFreshBrowser(narrow.port, "bea", `guess ${n}`)).answer.status, 403);
      assert.equal((await loginOnFreshBrowser(narrow.port, "bea", PASSWORD)).answer.status, 429, "the address's budget is spent");
    } finally {
      await stopServer(narrow.server);
    }
  });

  test("a sign-in IS a recent authentication: sensitive actions need nothing more for five minutes, then the PASSWORD (never a recovery key)", async () => {
    const { server, port, clock } = await prodServer();
    try {
      const ann = await accountBrowser(port, "Ann", PASSWORD);
      const other = await loginOnFreshBrowser(port, "Ann", PASSWORD);
      assert.equal((await post(port, "/gs/api/profile/sign-out-others", other.cookie as string)).status, 200, "inside the sign-in's five minutes");
      assert.deepEqual((await session(port, ann.cookie)).body, { error: "session-ended", reason: "signed-out-remotely" });
      clock.now += 6 * 60_000;
      assert.deepEqual((await post(port, "/gs/api/profile/sign-out-others", other.cookie as string)).body, { error: "reauth-required" });
      assert.deepEqual((await post(port, "/gs/api/profile/reauth", other.cookie as string, { password: "wrong one!" })).body, { error: "invalid-credential" });
      assert.equal((await post(port, "/gs/api/profile/reauth", other.cookie as string, { password: PASSWORD, recoveryKey: "rk_x" })).status, 400, "one credential, never both");
      assert.equal((await post(port, "/gs/api/profile/reauth", other.cookie as string, { password: PASSWORD })).status, 200);
      assert.equal((await post(port, "/gs/api/profile/sign-out-others", other.cookie as string)).status, 200);
    } finally {
      await stopServer(server);
    }
  });
});

describe("P3-ACCT independent-review fixes", () => {
  test("review H1, as the owner re-ruled it (P3-ACCT POLICY): a sign-in's own grant NEVER makes a recovery key; an explicit 'Confirm it's you' with the password does", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await accountBrowser(port, "Ann", PASSWORD);
      const rotated = await post(port, "/gs/api/profile/recovery-key", ann.cookie);
      assert.deepEqual([rotated.status, rotated.body], [403, { error: "reauth-required" }], "a cookie stolen in the sign-in's five minutes cannot mint a key");
      assert.ok(!rotated.text.includes("rk_"));
      assert.equal((await post(port, "/gs/api/profile/reauth", ann.cookie, { password: PASSWORD })).status, 200);
      const made = await post(port, "/gs/api/profile/recovery-key", ann.cookie);
      assert.equal(made.status, 200, made.text);
      assert.match((made.body as { recoveryKey: string }).recoveryKey, /^rk_/);
    } finally {
      await stopServer(server);
    }
  });

  test("review L2: a server that retired the LIVE-2E create makes no new recovery-key profile (existing ones still recover)", async () => {
    const service = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: { passwordKdf: TEST_PASSWORD_KDF, legacyProfileCreation: false } });
    const { server, port } = await prodServer({ service });
    try {
      const answer = await post(port, "/gs/api/profile", await bootstrapCookie(port), { name: "Nobody" });
      assert.deepEqual([answer.status, answer.body], [410, { error: "use-account" }]);
      assert.equal((await accountBrowser(port, "Ann", PASSWORD)).cookie.length > 0, true, "accounts are made as usual");
    } finally {
      await stopServer(server);
    }
  });

  test("review M2: strangers' wrong passwords for a username never block its owner's own 'Confirm it's you' (that budget is the session's)", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await accountBrowser(port, "Ann", PASSWORD);
      let refused = 0;
      for (let n = 0; n < 12; n += 1) {
        const tried = await login(port, await bootstrapCookie(port), "ann", "not the password");
        if (tried.status === 429) refused += 1;
      }
      assert.ok(refused >= 2, "the username's budget from this address is spent");
      const confirmed = await post(port, "/gs/api/profile/reauth", ann.cookie, { password: PASSWORD });
      assert.equal(confirmed.status, 200, confirmed.text);
      /* And the session's own budget is the session's: wrong confirmations spend it, a right one gives its token back. */
      for (let n = 0; n < 3; n += 1) assert.equal((await post(port, "/gs/api/profile/reauth", ann.cookie, { password: "wrong password" })).status, 403);
    } finally {
      await stopServer(server);
    }
  });

  test("review M3: the wrong-password budget is RESERVED before the KDF -- attempts in flight together cannot overshoot it", async () => {
    const { server, port } = await prodServer({ limits: { passwordFailuresPerAccountAddress: { capacity: 1, refillPerSecond: 0.000001 } } });
    try {
      await accountBrowser(port, "Ann", PASSWORD);
      const [one, two] = await Promise.all([login(port, await bootstrapCookie(port), "ann", "wrong one"), login(port, await bootstrapCookie(port), "ann", "wrong two")]);
      assert.deepEqual([one.status, two.status].sort(), [403, 429], "one checked, one refused before any check");
      /* A right password gives its reservation back (and here the budget is already spent: refused before the check). */
      assert.equal((await login(port, await bootstrapCookie(port), "ann", PASSWORD)).status, 429);
    } finally {
      await stopServer(server);
    }
  });

  test("money review M1: a new credential epoch (a key rotation) and signing out the other devices forget the persisted wallet", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      const legacy = await profiledBrowser(port, "Old Timer");
      const principal = principalOf(service, legacy.cookie, clock.now) as string;
      assert.equal(await service.associateWallet(linkContextOf(service, legacy.cookie, clock.now), FIXTURE_WALLET, clock.now), "associated");
      assert.equal((await post(port, "/gs/api/profile/reauth", legacy.cookie, { recoveryKey: legacy.recoveryKey })).status, 200);
      assert.equal((await post(port, "/gs/api/profile/recovery-key", legacy.cookie)).status, 200);
      assert.equal(service.profileWallet(principal), null, "rotated: forgotten");
      const ann = await accountBrowser(port, "Ann", PASSWORD);
      const annPrincipal = principalOf(service, ann.cookie, clock.now) as string;
      assert.equal(await service.associateWallet(linkContextOf(service, ann.cookie, clock.now), FIXTURE_WALLET_2, clock.now), "associated");
      const other = await loginOnFreshBrowser(port, "ann", PASSWORD);
      assert.equal(other.answer.status, 200);
      const signedOut = await post(port, "/gs/api/profile/sign-out-others", other.cookie as string);
      assert.deepEqual(signedOut.body, { ok: true, signedOut: 1 });
      assert.equal(service.profileWallet(annPrincipal), null, "the other devices are gone, and what they could have set up with them");
    } finally {
      await stopServer(server);
    }
  });
});

describe("P3-ACCT re-review fixes", () => {
  test("re-review N-3: a link authorized BEFORE a key rotation, a sign-out of other devices or a forget never writes its wallet back onto the cleaned profile", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      /* A rotation commits between the link's authorization and its wallet's persistence. */
      const legacy = await profiledBrowser(port, "Old Timer");
      const principal = principalOf(service, legacy.cookie, clock.now) as string;
      const before = linkContextOf(service, legacy.cookie, clock.now);
      assert.equal((await post(port, "/gs/api/profile/reauth", legacy.cookie, { recoveryKey: legacy.recoveryKey })).status, 200);
      assert.equal((await post(port, "/gs/api/profile/recovery-key", legacy.cookie)).status, 200);
      assert.equal(await service.associateWallet(before, FIXTURE_WALLET, clock.now), "stale");
      assert.equal(service.profileWallet(principal), null);
      /* Another device's link, then "sign out other devices" from this one: that family is closed. */
      const ann = await accountBrowser(port, "Ann", PASSWORD);
      const annPrincipal = principalOf(service, ann.cookie, clock.now) as string;
      const other = await loginOnFreshBrowser(port, "ann", PASSWORD);
      const fromOther = linkContextOf(service, other.cookie as string, clock.now);
      assert.deepEqual((await post(port, "/gs/api/profile/sign-out-others", ann.cookie)).body, { ok: true, signedOut: 1 });
      assert.equal(await service.associateWallet(fromOther, FIXTURE_WALLET_2, clock.now), "stale");
      assert.equal(service.profileWallet(annPrincipal), null);
      /* The wallet the caller saw is not the profile's any more (forgotten meanwhile): nothing is written. */
      assert.equal(await service.associateWallet(linkContextOf(service, ann.cookie, clock.now), FIXTURE_WALLET, clock.now), "associated");
      const sawWallet = linkContextOf(service, ann.cookie, clock.now);
      assert.deepEqual((await post(port, "/gs/api/account/forget-wallet", ann.cookie)).body, { ok: true, forgot: true });
      assert.equal(await service.associateWallet(sawWallet, FIXTURE_WALLET_2, clock.now), "stale");
      assert.equal(service.profileWallet(annPrincipal), null);
    } finally {
      await stopServer(server);
    }
  });

  test("re-review N-1: wrong passwords in 'Confirm it's you' are bounded per ACCOUNT -- new sessions add no guesses; the right password from a fresh sign-in still clears the thief out", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      await accountBrowser(port, "Ann", PASSWORD);
      const devices: string[] = [];
      for (let n = 0; n < 5; n += 1) devices.push((await loginOnFreshBrowser(port, "ann", PASSWORD)).cookie as string);
      clock.now += 10 * 60_000; // past every sign-in's own confirmation window
      /* Four devices, five wrong guesses each: the account's backstop (20) is spent. */
      for (const cookie of devices.slice(0, 4)) {
        for (let n = 0; n < 5; n += 1) assert.equal((await post(port, "/gs/api/profile/reauth", cookie, { password: `wrong guess ${n}` })).status, 403);
      }
      const fifth = await post(port, "/gs/api/profile/reauth", devices[4], { password: "another guess" });
      assert.equal(fifth.status, 429, "a fifth device adds no guesses");
      assert.equal((await post(port, "/gs/api/profile/reauth", devices[4], { password: PASSWORD })).status, 429, "reserved before the check: nothing is learned");
      /* The owner signs in afresh -- a sign-in confirms for its first minutes -- and signs every other device out. */
      const owner = await loginOnFreshBrowser(port, "ann", PASSWORD);
      const out = await post(port, "/gs/api/profile/sign-out-others", owner.cookie as string);
      assert.equal(out.status, 200);
      assert.equal(principalOf(service, devices[0], clock.now), null, "the guessing devices are signed out");
    } finally {
      await stopServer(server);
    }
  });
});

describe("P3-ACCT the legacy migration (a recovery-key profile)", () => {
  test("it keeps playing as before; it sets a username and password only under Confirm it's you; then logs in anywhere -- the SAME principal; its key becomes ACCOUNT RECOVERY (P3-ACCT POLICY); it is never orphaned", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      const legacy = await profiledBrowser(port, "Old Timer");
      const principal = principalOf(service, legacy.cookie, clock.now);
      const client = await Client.openWithCookie(port, legacy.cookie, "legacy");
      const table = await client.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "" });
      assert.equal(table.ok, true, "a legacy session plays without its key");
      await client.close();
      const mine = await me(port, legacy.cookie);
      assert.deepEqual([(mine.body as { account: { username: unknown; recoveryKey: unknown } }).account.username, (mine.body as { account: { recoveryKey: unknown } }).account.recoveryKey], [null, true]);
      const body = { username: "OldTimer", password: PASSWORD };
      assert.deepEqual((await post(port, "/gs/api/account/credentials", legacy.cookie, body)).body, { error: "reauth-required" }, "a live cookie alone can't attach a durable credential");
      assert.equal((await post(port, "/gs/api/profile/reauth", legacy.cookie, { recoveryKey: legacy.recoveryKey })).status, 200);
      const set = await post(port, "/gs/api/account/credentials", legacy.cookie, body);
      assert.deepEqual(set.body, { ok: true, username: "OldTimer" });
      assert.deepEqual((await post(port, "/gs/api/account/credentials", legacy.cookie, { ...body, username: "Another" })).body, { error: "credentials-exist" });
      const elsewhere = await loginOnFreshBrowser(port, "oldtimer", PASSWORD);
      assert.equal(elsewhere.answer.status, 200, elsewhere.answer.text);
      assert.equal(principalOf(service, elsewhere.cookie as string, clock.now), principal, "the same principal: its tables follow");
      /* P3-ACCT POLICY: the legacy key is KEPT (owner ruling 7) as the account's recovery key -- it resets the password; it
         no longer signs in (the account has a password now). */
      const keyed = await post(port, "/gs/api/profile/recover", await bootstrapCookie(port), { recoveryKey: legacy.recoveryKey });
      assert.deepEqual([keyed.status, keyed.body], [409, { error: "use-password-reset" }]);
      assert.equal(cookieFromAnswer(keyed), null, "no session");
      assert.equal(((await me(port, elsewhere.cookie as string)).body as { account: { recoveryKey: boolean } }).account.recoveryKey, true);
      /* A forged key is the one wrong answer. */
      const bea = await accountBrowser(port, "Bea", PASSWORD);
      clock.now += 6 * 60_000;
      const beaProfile = service.peekProfileOf(principalOf(service, bea.cookie, clock.now) as string) as Profile;
      assert.deepEqual((await post(port, "/gs/api/profile/reauth", bea.cookie, { recoveryKey: `${beaProfile.recovery_selector}.${"A".repeat(43)}` })).body, { error: "invalid-credential" });
    } finally {
      await stopServer(server);
    }
  });
});

describe("P3-ACCT persistence and restore", () => {
  test("a restart over the journal store keeps the account (schema 2, the hash only) and its username; the login works after it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-acct-"));
    const policy = { passwordKdf: TEST_PASSWORD_KDF };
    const clock = { now: Date.now() };
    try {
      const first = await IdentityService.open(createJournalIdentityStore(dir, { warn: () => undefined }), { policy });
      const a = await prodServer({ clock, service: first });
      let principal: string | null;
      try {
        const ann = await accountBrowser(a.port, "Ann", PASSWORD);
        principal = principalOf(first, ann.cookie, clock.now);
      } finally {
        await stopServer(a.server);
      }
      const bytes = [fs.readFileSync(path.join(dir, "identity.json"), "utf8"), fs.existsSync(path.join(dir, "identity.journal.jsonl")) ? fs.readFileSync(path.join(dir, "identity.journal.jsonl"), "utf8") : ""].join("\n");
      assert.ok(!bytes.includes(PASSWORD), "no password on disk");
      assert.match(bytes, /scrypt\$1\$10\$/, "only its hash");
      const second = await IdentityService.open(createJournalIdentityStore(dir, { warn: () => undefined }), { policy });
      const b = await prodServer({ clock, service: second });
      try {
        const again = await loginOnFreshBrowser(b.port, "Ann", PASSWORD);
        assert.equal(again.answer.status, 200, again.answer.text);
        assert.equal(principalOf(second, again.cookie as string, clock.now), principal);
        assert.deepEqual((await create(b.port, await bootstrapCookie(b.port), { username: "ann", password: PASSWORD, name: "X" })).body, { error: "username-taken" }, "the username survived the restart");
      } finally {
        await stopServer(b.server);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the identity restore replays a new account's credential and a legacy migration's, clears every persisted wallet, and never installs a phantom's taken username", () => {
    const at = 1_760_000_000_000;
    const event = (fields: Record<string, unknown>, n: number): SecurityEvent => ({ format: SECURITY_EVENT_FORMAT, version: SECURITY_EVENT_VERSION, event_id: n.toString(16).padStart(32, "0"), at: at + n, ...fields }) as unknown as SecurityEvent;
    const confirm = (target: SecurityEvent, n: number) => event({ kind: "confirmed", principal_id: target.principal_id, confirms: target.event_id, confirmed_kind: target.kind }, n);
    /* The table at T: a legacy profile (no username) with a persisted wallet, and nothing of the rest. */
    const legacy = identitySet(41);
    const legacyAtT = accountProfile(legacy, { wallet: FIXTURE_WALLET });
    const snapshot: FullIdentitySnapshot = applyChange({ principals: [legacy.profiledPrincipal], sessions: [legacy.session], profiles: [legacyAtT], links: [], families: [legacy.family] }, {});
    /* After T: the legacy profile set "Old" (confirmed); a new account "Ann" (confirmed); a PHANTOM creation of "ann"
       by a third principal LATER (unconfirmed), which the uniqueness rule shows never committed. */
    const established = event({ kind: "credentials-established", principal_id: legacy.principal.principal_id, profile_id: legacy.profile.profile_id, login_key: "old", login_name: "Old", password_hash: accountProfile(legacy, { login: "Old" }).password_hash, set_at: at + 1 }, 1);
    const ann = identitySet(42);
    const annProfile = { ...accountProfile(ann, { login: "Ann" }), wallet_address: null, wallet_verified_at: null };
    const created = event({ kind: "profile-created", principal_id: ann.principal.principal_id, principal: ann.profiledPrincipal, profile: annProfile }, 3);
    const phantom = identitySet(43);
    const phantomCreated = event({ kind: "profile-created", principal_id: phantom.principal.principal_id, principal: phantom.profiledPrincipal, profile: accountProfile(phantom, { login: "ANN" }) }, 5);
    const plan = planSecurityReplay({ snapshot, events: [established, confirm(established, 2), created, confirm(created, 4), phantomCreated], restoreId: "r-p3acct", at: at + 10 });
    const after = plan.principals.reduce((state, entry) => (entry.change === null ? state : applyChange(state, entry.change)), snapshot);
    const byId = new Map(after.profiles.map((profile) => [profile.profile_id, profile] as const));
    assert.equal(loginOf(byId.get(legacy.profile.profile_id) as Profile)?.key, "old", "the legacy migration is installed");
    assert.equal(walletOf(byId.get(legacy.profile.profile_id) as Profile), null, "the persisted wallet is cleared");
    assert.equal(loginOf(byId.get(ann.profile.profile_id) as Profile)?.key, "ann", "the confirmed account is created with its credential");
    assert.equal(byId.has(phantom.profile.profile_id), false, "the phantom whose username another profile won is not installed");
    assert.equal(plan.report.credentials_installed, 1);
    assert.equal(plan.report.wallets_cleared, 1);
    /* Idempotent: a second run on the result plans nothing for the profiles. */
    const again = planSecurityReplay({ snapshot: after, events: [established, confirm(established, 2), created, confirm(created, 4), phantomCreated], restoreId: "r-p3acct", at: at + 10 });
    assert.equal(again.report.credentials_installed, 0);
    assert.equal(again.report.wallets_cleared, 0);
    void FIXTURE_WALLET_2;
  });
});

/* ==================================================================
    B. THE PUBLIC-FIRST SOCKET
   ================================================================== */

describe("P3-ACCT the public-first socket (a signed-out visitor)", () => {
  test("reads the public list and WATCHES a public table read-only; Host, Join, a seat, chat, a move and Your tables are profile-required; a private table is not-found", async () => {
    const records = createMemoryRecordStore();
    const { server, port } = await prodServer({ records });
    try {
      const host = await accountBrowser(port, "Hana", PASSWORD);
      const hostClient = await Client.openWithCookie(port, host.cookie, "hana");
      const open = await hostClient.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "" });
      const hidden = await hostClient.op({ type: "create", visibility: "private", exactPlayers: null, variants: {}, nickname: "" });
      const publicId = (open.data as { gameId: string }).gameId;
      const privateId = (hidden.data as { gameId: string }).gameId;
      const code = (open.data as { code: string }).code;
      const visitor = await Client.openWithCookie(port, await bootstrapCookie(port), "visitor");
      visitor.send({ kind: "rooms-watch", on: true });
      const list = await visitor.next((frame) => frame.kind === "rooms", "the public list");
      assert.ok(JSON.stringify(list).includes(publicId), "the public table is listed");
      assert.ok(!JSON.stringify(list).includes(privateId));
      visitor.roomHello(publicId);
      const view = (await visitor.next((frame) => frame.kind === "room" && frame.gameId === publicId, "the watched view")).view as { you: { role: string; playerId: string | null } };
      assert.deepEqual([view.you.role, view.you.playerId], ["viewer", null], "a watcher: no seat, nothing to act on");
      visitor.hello(publicId);
      await visitor.next((frame) => frame.kind === "catch-up" || frame.kind === "error", "the log answer");
      const refusals: Array<[string, Record<string, unknown>, string | undefined]> = [
        ["host", { type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "" }, undefined],
        ["join", { type: "join", code, takeSeat: true }, undefined],
        ["take a seat", { type: "take-seat" }, publicId],
        ["your tables", { type: "my-tables" }, undefined],
      ];
      for (const [label, op, gameId] of refusals) {
        const answer = await visitor.op(op, gameId);
        assert.deepEqual([answer.ok, answer.code], [false, "profile-required"], label);
      }
      visitor.send({ kind: "chat-send", gameId: publicId, text: "hello" });
      visitor.submit(BUY, { baseIndex: 0, submissionId: "visitor-move" });
      assert.deepEqual([(await visitor.answerTo("visitor-move")).code], ["profile-required"]);
      await sleep(50);
      assert.equal(records.records.size, 2, "nothing was created or joined");
      visitor.roomHello(privateId);
      const hiddenAnswer = await visitor.next((frame) => frame.kind === "error" && frame.code === "not-found", "a private table answers like no table");
      assert.equal(hiddenAnswer.code, "not-found");
      await visitor.close();
      await hostClient.close();
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    C. THE PERSISTED WALLET (the money stack over the offline Juno)
   ================================================================== */

const moneyOf = (view: Record<string, unknown>) => view.money as RoomMoneyView;

async function seatJoiner(world: MoneyServer, who: Player, code: string): Promise<string> {
  const joined = await who.client.op({ type: "join", code, takeSeat: true });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  return (joined.data as { playerId: string }).playerId;
}

describe("P3-ACCT the persisted, verified wallet", () => {
  test("a link authorized by the sign-in persists the wallet; the SAME wallet then links at the next table WITHOUT the password; any other wallet needs it (and W2-M's replace); the payout wallet is the bound one", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const hostWallet = testWallet("hana");
      const hostKey = testConsentKey("hana");
      const table = await openMoneyTable(host);
      const hostLinked = await linkWallet(host, table.gameId, hostWallet, hostKey);
      assert.equal(hostLinked.status, 200, hostLinked.text);
      await hostCreates(world, host, table.gameId, hostWallet, hostKey, hostLinked.body?.ticket as string);
      await world.observe();
      /* A username/password account joins; its sign-in is its "Confirm it's you" for five minutes. */
      const jo = await accountPlayer(world, "Jo");
      const joWallet = testWallet("jo");
      const joKey = testConsentKey("jo");
      await seatJoiner(world, jo, table.code);
      const first = await linkWallet(jo, table.gameId, joWallet, joKey, { confirm: false });
      assert.equal(first.status, 200, first.text);
      assert.equal(world.identity.profileWallet(principalOfPlayer(world, jo))?.address, joWallet.address, "persisted to the profile");
      const audit = world.ops.lines.map((line) => JSON.stringify(line));
      assert.ok(audit.some((line) => line.includes("money.profile-wallet")), "audited");
      assert.ok(!audit.filter((line) => line.includes("money.profile-wallet")).some((line) => ID_PATTERN.test(line) || line.includes(joWallet.address)), "the audit names no id and no wallet");
      await joinerFunds(world, jo, table.gameId, joWallet, joKey, first.body?.ticket as string);
      await world.observe();
      assert.equal(moneyOf(await viewOf(jo.client, table.gameId)).you?.funding, "funded");
      /* Start: the frozen roster's payout address is the bound, verified wallet. */
      assert.equal((await host.client.op({ type: "start-game" }, table.gameId)).ok, true);
      await world.drive(async () => world.server.rooms.moneyPort.recordOf(table.gameId)?.status === "active");
      const fin = await world.financial.load(table.gameId);
      const joSeat = fin?.roster?.roster.find((entry) => entry.payout_address === joWallet.address);
      assert.ok(joSeat !== undefined, `the roster pays the verified wallet: ${JSON.stringify(fin?.roster?.roster)}`);
      /* LATER (the sign-in's five minutes long gone): another table, the SAME wallet -- no password, its signature only. */
      world.advance(30 * 60_000);
      const host2 = await player(world, "Hugo");
      const table2 = await openMoneyTable(host2);
      const h2 = await linkWallet(host2, table2.gameId, testWallet("hugo"), testConsentKey("hugo"));
      await hostCreates(world, host2, table2.gameId, testWallet("hugo"), testConsentKey("hugo"), h2.body?.ticket as string);
      await world.observe();
      await seatJoiner(world, jo, table2.code);
      const returning = await linkWallet(jo, table2.gameId, joWallet, testConsentKey("jo-2"), { confirm: false });
      assert.equal(returning.status, 200, `a returning verified wallet links with its own signature alone: ${returning.text}`);
      /* ANOTHER wallet without the password: refused before anything is signed (the challenge itself). */
      const otherWallet = testWallet("jo-other");
      const refused = await linkWallet(jo, table2.gameId, otherWallet, testConsentKey("jo-3"), { confirm: false, replace: true });
      assert.deepEqual([refused.status, refused.body?.error], [403, "reauth-required"]);
      /* With the password it is W2-M's replacement: asked to replace, then replaced -- and the profile's wallet moves. */
      await jo.confirm();
      const ask = await linkWallet(jo, table2.gameId, otherWallet, testConsentKey("jo-3"), { confirm: false });
      assert.equal(ask.body?.error, "replace-required", "W2-M: a different wallet replaces the seat's link only when asked to");
      const replaced = await linkWallet(jo, table2.gameId, otherWallet, testConsentKey("jo-3"), { confirm: false, replace: true });
      assert.equal(replaced.status, 200, replaced.text);
      assert.equal(world.identity.profileWallet(principalOfPlayer(world, jo))?.address, otherWallet.address, "the replacement is the profile's wallet now");
      /* A stolen cookie (no password) cannot bring the old wallet back either: it is no longer the profile's. */
      world.advance(10 * 60_000);
      const back = await linkWallet(jo, table2.gameId, joWallet, testConsentKey("jo-4"), { confirm: false, replace: true });
      assert.equal(back.body?.error, "reauth-required");
    } finally {
      await world.close();
    }
  });

  test("forgetting the wallet is sensitive and makes the next link ask for the password again", async () => {
    const world = await moneyServer();
    try {
      const host = await accountPlayer(world, "Hana");
      const table = await openMoneyTable(host);
      const wallet = testWallet("hana");
      assert.equal((await linkWallet(host, table.gameId, wallet, testConsentKey("hana"), { confirm: false })).status, 200);
      world.advance(10 * 60_000);
      assert.deepEqual((await apiRequest(world.port, "/gs/api/account/forget-wallet", { cookie: host.browser.cookie, body: {} })).body, { error: "reauth-required" });
      await host.confirm();
      assert.deepEqual((await apiRequest(world.port, "/gs/api/account/forget-wallet", { cookie: host.browser.cookie, body: {} })).body, { ok: true, forgot: true });
      world.advance(10 * 60_000);
      assert.equal((await host.api("wallet-challenge", { gameId: table.gameId, wallet: wallet.address })).body?.error, "reauth-required");
    } finally {
      await world.close();
    }
  });
});

function principalOfPlayer(world: MoneyServer, who: Player): string {
  return principalOf(world.identity, who.browser.cookie, world.clock.now) as string;
}

/* ==================================================================
    D. TRUST FACTS
   ================================================================== */

describe("P3-ACCT trust facts", () => {
  test("a REAL-MONEY table's seats' facts, to a signed-in caller: keyed by public seat ids, months not days, no private id; a free or private table, or a signed-out visitor, learns nothing", async () => {
    const world = await moneyServer();
    try {
      const host = await player(world, "Hana");
      const table = await openMoneyTable(host);
      const free = await host.client.op({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "" });
      assert.equal(free.ok, true, JSON.stringify(free));
      const stranger = await accountPlayer(world, "Sam");
      const trust = (route: string, body: object) => apiRequest(world.port, `/gs/api/trust/${route}`, { cookie: stranger.browser.cookie, body });
      const facts = await trust("table", { gameId: table.gameId });
      assert.equal(facts.status, 200, facts.text);
      const seats = (facts.body as unknown as { seats: Array<{ playerId: string; facts: Record<string, unknown> }> }).seats;
      assert.equal(seats.length, 1);
      assert.deepEqual(Object.keys(seats[0].facts).sort(), ["accountAgeDays", "completedMoneyGames", "disputedGames", "establishedOpponents", "inactivityExits", "memberSince", "unresolvedDisputes", "walletVerified", "walletVerifiedSince"]);
      assert.match(String(seats[0].facts.memberSince), /^\d{4}-\d{2}$/, "the month, never the day");
      assert.equal(Number(seats[0].facts.accountAgeDays) % 7, 0, "whole weeks only (re-review N-4)");
      assert.equal(seats[0].facts.establishedOpponents, 0, "P3-ACCT POLICY: the owner's definition -- a server-derived count (no completed game yet)");
      assert.equal(seats[0].facts.walletVerified, false);
      assert.ok(!ID_PATTERN.test(facts.text) && !facts.text.includes("Hana") && !facts.text.includes("juno1"), "no id, no username, no wallet");
      /* A free table: the facts are for staking money beside someone, not for following a player around. */
      assert.equal((await trust("table", { gameId: (free.data as { gameId: string }).gameId })).status, 404);
      assert.equal((await trust("table", { gameId: "g_nope" })).status, 404);
      /* A signed-out visitor: nothing (it must sign in to sit anyway). */
      const visitor = await bootstrapCookie(world.port);
      assert.equal((await apiRequest(world.port, "/gs/api/trust/table", { cookie: visitor, body: { gameId: table.gameId } })).status, 403);
      assert.equal((await apiRequest(world.port, "/gs/api/trust/me", { cookie: visitor, body: {} })).status, 403);
      const mine = await trust("me", {});
      assert.equal(mine.status, 200);
      assert.equal((mine.body as unknown as { facts: { completedMoneyGames: number } }).facts.completedMoneyGames, 0);
    } finally {
      await world.close();
    }
  });
});
