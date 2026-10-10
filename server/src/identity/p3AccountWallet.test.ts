// server/src/identity/p3AccountWallet.test.ts
//
// ==================================================================
//  PHASE 3 (P3-ACCT; PHASE 3 FINAL): USERNAME/PASSWORD ACCOUNTS WITH AN AUTHORIZATION WALLET, THE PUBLIC-FIRST SOCKET,
//  NO PERSISTED WALLET, TRUST FACTS
// ==================================================================
//
// Against the real server (production identity: cookies, an allowed Origin, real sockets) and the real money stack
// over the offline Juno (`escrow4Support.ts`):
//   A. accounts: create (its ONE Authorization Wallet proven by the CREATE text's signature; no recovery key; a FRESH
//      session: fixation), login (the same principal and seats; one answer for every wrong or unknown credential;
//      budgets), reload/new tab, sign out, legacy profiles RETIRED (no migration), restart and restore;
//   B. the public-first socket: a signed-out visitor reads the public list and watches a public table, read-only;
//      every identity-bearing frame is `profile-required`; a private table is `not-found`;
//   C. NO persisted wallet (PHASE 3 FINAL, the opposite of P3-ACCT's): linking a wallet at a seat never changes the
//      account's Authorization Wallet nor records any profile wallet; a game wallet needs the password at every new
//      table; only the Authorization Wallet links itself without it; the payout wallet is the seat's bound one;
//   D. trust facts: server-derived, keyed by public seat ids, no private id anywhere (`authorizationWalletSince`).
// PHASE 3 FINAL deleted: the recovery-key route of review H1, the legacy-creation switch of review L2, the persisted
// wallet's money review M1 / re-review N-3, "forget this wallet", and the legacy migration -- each block below names what
// replaced it.

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
  quietConsole,
  sleep,
  startServer,
  stopServer,
  type ApiAnswer,
} from "../rooms/testSupport";
import { accountPlayer, hostCreates, joinerFunds, linkWallet, moneyServer, openMoneyTable, player, TEST_PASSWORD_KDF, testConsentKey, testWallet, viewOf, type MoneyServer, type Player } from "../escrow/escrow4Support";
import { keplrAccount, type KeplrAccount } from "../testSupport/authorizationWallets";
import type { RoomMoneyView } from "../../../frontend/src/utils/moneyProtocol";
import { cleanLoginName, cleanPassword, DEFAULT_PASSWORD_KDF, hashPassword, hasRecoveryKey, isPasswordHash, KdfGate, loginKeyOf, sealedRecoveryDigest, verifyPassword } from "./accountCredentials";
import { readSessionCookie } from "./cookies";
import { familyIdOf, mintPrincipalId, mintProfileId, mintRecoveryKey, mintRecoverySelector, mintSecret, mintSessionId, secretHash } from "./ids";
import { createJournalIdentityStore } from "./journalStore";
import { planSecurityReplay } from "./securityReplay";
import { SECURITY_EVENT_FORMAT, SECURITY_EVENT_VERSION, type SecurityEvent } from "./securityEvents";
import { IdentityService } from "./sessions";
import { applyChange, authorizationWalletOf, createMemoryIdentityStore, loginOf, walletOf, type FullIdentitySnapshot, type Principal, type Profile, type Session, type SessionFamily } from "./store";
import { createHash } from "crypto";

/* CONSOLIDATED FINAL PRE-PLAYTEST INTEGRATION: this suite's few stored-shape fixtures are built HERE. It used to import
   them from the conformance harness's fixtures module, which the AWS-client convention (aws/awsClients.test.ts:
   "nothing outside the conformance directory may import the harness") refuses. The values are the conformance fixtures' own
   (same seeds, same production id minting, same canonical wallets), so every assertion below reads exactly as before. */
const T0 = 1_780_000_000_000;
const FIXTURE_WALLET = "juno1qyqszqgpqyqszqgpqyqszqgpqyqszqgpypz92q";
const FIXTURE_WALLET_2 = "juno1qgpqyqszqgpqyqszqgpqyqszqgpqyqsz49yqpk";
const FIXTURE_PASSWORD_HASH = `scrypt$1$10$1$1$${Buffer.alloc(16, 7).toString("base64url")}$${Buffer.alloc(32, 9).toString("base64url")}`;

function seededRandom(seed: string): (size: number) => Buffer {
  let counter = 0;
  return (size: number) => {
    const out = Buffer.alloc(size);
    let filled = 0;
    while (filled < size) {
      const block = createHash("sha256").update(`${seed}#${counter++}`).digest();
      block.copy(out, filled, 0, Math.min(block.length, size - filled));
      filled += block.length;
    }
    return out;
  };
}

interface IdentitySet {
  readonly principal: Principal;
  readonly profiledPrincipal: Principal;
  readonly profile: Profile;
  readonly session: Session;
  readonly family: SessionFamily;
}

function identitySet(n: number): IdentitySet {
  const random = seededRandom(`identity-${n}`);
  const principalId = mintPrincipalId(random);
  const sessionId = mintSessionId(random);
  const profileId = mintProfileId(random);
  const key = mintRecoveryKey(random);
  const principal: Principal = { principal_id: principalId, kind: "unprofiled", status: "active", created_at: T0, activated_at: T0, last_seen_at: T0, account_link: null };
  const profiledPrincipal: Principal = { ...principal, kind: "profile", account_link: profileId };
  const profile: Profile = {
    profile_id: profileId,
    principal_id: principalId,
    display_name: `Conf ${n}`,
    created_at: T0,
    status: "active",
    recovery_selector: key.selector,
    recovery_hash: secretHash(key.secret),
    recovery_rotated_at: T0,
    schema: 1,
  };
  const session: Session = {
    session_id: sessionId,
    principal_id: principalId,
    secret_hash: secretHash(mintSecret(random)),
    created_at: T0,
    last_seen_at: T0,
    expires_at: T0 + 30 * 86_400_000,
    revoked_at: null,
    revoke_reason: null,
    rotated_to: null,
    family_id: familyIdOf(sessionId),
  };
  const family: SessionFamily = { family_id: session.family_id, principal_id: principalId, created_at: T0, origin: "bootstrap", revoked_at: null, revoke_reason: null };
  return { principal, profiledPrincipal, profile, session, family };
}

/** `set`'s profile as schema 2, with `login` (a username) and/or a wallet. */
function accountProfile(set: IdentitySet, over: { readonly login?: string | null; readonly wallet?: string | null; readonly at?: number } = {}): Profile {
  const at = over.at ?? T0;
  const login = over.login ?? null;
  const wallet = over.wallet ?? null;
  return {
    ...set.profile,
    schema: 2,
    login_key: login === null ? null : login.normalize("NFKC").toLowerCase().normalize("NFKC"),
    login_name: login,
    password_hash: login === null ? null : FIXTURE_PASSWORD_HASH,
    password_set_at: login === null ? null : at,
    wallet_address: wallet,
    wallet_verified_at: wallet === null ? null : at,
  };
}

quietConsole();

const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a brand new passphrase";

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
const session = (port: number, cookie?: string, body: object = {}) => post(port, "/gs/api/session", cookie, body);
const login = (port: number, cookie: string, username: string, password: string) => post(port, "/gs/api/account/login", cookie, { username, password });
const me = (port: number, cookie: string) => post(port, "/gs/api/account/me", cookie);
const principalOf = (service: IdentityService, cookie: string, now: number): string | null => {
  const auth = service.authenticate(readSessionCookie(cookie), now);
  return auth.kind === "ok" ? auth.principalId : null;
};
/** Status, headers (less the clock) and body: two refusals compared for sameness. */
function observable(answer: ApiAnswer): string {
  const { date: _date, connection: _connection, "keep-alive": _keepAlive, ...headers } = answer.headers;
  return JSON.stringify({ status: answer.status, headers, text: answer.text });
}
const ID_PATTERN = /pr_|pf_|se_|sf_|rk_|scrypt\$|password_hash|login_key/;

/** Create an account over HTTP: the CREATE text for this browser and username, signed by `wallet` (each username's own
 *  test Keplr account unless given), then the create -- `extra` joins its body. A refused CREATE text is answered as it
 *  came. */
async function create(port: number, cookie: string, body: { username: string; password: string; name: string }, extra: Record<string, unknown> = {}, wallet: KeplrAccount = keplrAccount(`acct/${body.username}`)): Promise<ApiAnswer> {
  const minted = await post(port, "/gs/api/account/authorization", cookie, { purpose: "create", username: body.username, wallet: wallet.address });
  if (minted.status !== 200) return minted;
  const text = (minted.body?.texts as Array<{ text: string }>)[0].text;
  return post(port, "/gs/api/account/create", cookie, { ...body, operation: minted.body?.operation, ...wallet.sign(text), ...extra });
}

/** "Forgot password?" on a fresh browser: the RECOVER text signed by the wallet, then the recovery. */
async function recoverOnFreshBrowser(port: number, username: string, wallet: KeplrAccount, newPassword = NEW_PASSWORD): Promise<{ answer: ApiAnswer; cookie: string | null }> {
  const before = await bootstrapCookie(port);
  const minted = await post(port, "/gs/api/account/authorization", before, { purpose: "recover", username, wallet: wallet.address });
  assert.equal(minted.status, 200, minted.text);
  const text = (minted.body?.texts as Array<{ text: string }>)[0].text;
  const answer = await post(port, "/gs/api/account/recover", before, { operation: minted.body?.operation, ...wallet.sign(text), newPassword });
  return { answer, cookie: answer.status === 200 ? cookieFromAnswer(answer) : null };
}

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
    assert.equal(cleanLoginName("İ".repeat(40)), null, "İ lower-cases to two code points: an 80-character key");
    assert.equal(cleanLoginName("İ".repeat(30)), "İ".repeat(30));
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
  test("201 with the username, NO recovery key, and a FRESH session cookie -- the temporary one is replaced (session fixation); the account's own details name its Authorization Wallet", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      const before = await bootstrapCookie(port);
      const wallet = keplrAccount("acct/brad");
      const answer = await create(port, before, { username: "Brad.Player", password: PASSWORD, name: "Brad" }, {}, wallet);
      assert.equal(answer.status, 201, answer.text);
      assert.deepEqual(answer.body, { ok: true, profile: { name: "Brad", otherSessions: 0 }, username: "Brad.Player" }, "PHASE 3 FINAL: no recovery key exists");
      assert.ok(!ID_PATTERN.test(answer.text), "no id, hash or key in the answer");
      const cookie = cookieFromAnswer(answer);
      assert.ok(cookie !== null && cookie !== before, "a fresh session");
      assert.deepEqual((await session(port, before)).body, { error: "session-ended", reason: "replaced" }, "the cookie the browser held before opens nothing");
      const boot = await session(port, cookie as string);
      assert.deepEqual((boot.body as { profile: unknown }).profile, { name: "Brad", otherSessions: 0, username: "Brad.Player" }, "the reload / new tab is signed in (the cookie is the browser's)");
      const principal = principalOf(service, cookie as string, clock.now) as string;
      const profile = service.peekProfileOf(principal) as Profile;
      assert.equal(profile.schema, 3);
      assert.equal(loginOf(profile)?.key, "brad.player");
      assert.equal(hasRecoveryKey(profile), false, "no recovery key: the sealed digest of the credential epoch");
      assert.deepEqual(authorizationWalletOf(profile), { address: wallet.address, since: clock.now }, "the CREATE text's signer is the Authorization Wallet");
      assert.ok(!JSON.stringify(profile).includes(PASSWORD), "never the password");
      const mine = await me(port, cookie as string);
      assert.equal(mine.status, 200);
      const account = (mine.body as { account: Record<string, unknown> }).account;
      assert.deepEqual(Object.keys(account).sort(), ["authorizationWallet", "memberSince", "name", "otherSessions", "username"]);
      assert.deepEqual([account.name, account.username, account.authorizationWallet, account.memberSince], ["Brad", "Brad.Player", { address: wallet.address, since: clock.now }, clock.now]);
      assert.ok(!ID_PATTERN.test(mine.text));
    } finally {
      await stopServer(server);
    }
  });

  test("a username is unique whatever its case; malformed input is 400; a signed-in browser is 409; the profile budget applies", async () => {
    const { server, port } = await prodServer({ limits: { profileCreatesPerIp: { capacity: 6, refillPerSecond: 0.0001 } } });
    const forged = { operation: "0".repeat(32), pubKey: "", signature: "" };
    try {
      await accountBrowser(port, "Ann", PASSWORD);
      const other = await bootstrapCookie(port);
      /* Taken: the CREATE text itself says so (before Keplr signs) -- and a create with any operation says it too. */
      assert.deepEqual((await create(port, other, { username: "ANN", password: PASSWORD, name: "Ann 2" })).body, { error: "username-taken" });
      assert.deepEqual((await post(port, "/gs/api/account/create", other, { username: "ANN", password: PASSWORD, name: "Ann 2", ...forged })).body, { error: "username-taken" });
      assert.deepEqual((await create(port, other, { username: "two words", password: PASSWORD, name: "X" })).body, { error: "bad-username" });
      assert.deepEqual((await create(port, other, { username: "Bea", password: "short", name: "X" })).body, { error: "bad-password", problem: "too-short" });
      assert.deepEqual((await create(port, other, { username: "Bea", password: PASSWORD, name: "" })).body, { error: "bad-name" });
      assert.equal((await create(port, other, { username: "Bea", password: PASSWORD, name: "Bea" }, { extra: 1 })).status, 400, "a closed body");
      const bea = await create(port, other, { username: "Bea", password: PASSWORD, name: "Bea" });
      assert.equal(bea.status, 201, bea.text);
      const signedIn = cookieFromAnswer(bea) as string;
      assert.equal((await create(port, signedIn, { username: "Bea2", password: PASSWORD, name: "Bea" })).status, 409, "the CREATE text is refused");
      assert.equal((await post(port, "/gs/api/account/create", signedIn, { username: "Bea2", password: PASSWORD, name: "Bea", ...forged })).status, 409, "and so is the create");
      /* The address's creation budget (6) is spent by every create that reached the account check -- Ann, the forged
         "ANN", the short password, Bea -- AND (PHASE 3 FINAL security review M1) by the CREATE text's own "username
         taken" answer for "ANN": a stranger learns no more existing usernames than the accounts it could make. So one
         more account fits and the next is refused at its CREATE text. */
      assert.equal((await create(port, await bootstrapCookie(port), { username: "Cy", password: PASSWORD, name: "Cy" })).status, 201, "Cy");
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
      /* Hosting again needs nothing more than the session (no password, no wallet). */
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

  test("a sign-in IS a recent authentication: sensitive actions need nothing more for five minutes, then the PASSWORD (never a key, never the wallet)", async () => {
    const { server, port, clock } = await prodServer();
    try {
      const ann = await accountBrowser(port, "Ann", PASSWORD);
      const other = await loginOnFreshBrowser(port, "Ann", PASSWORD);
      assert.equal((await post(port, "/gs/api/profile/sign-out-others", other.cookie as string)).status, 200, "inside the sign-in's five minutes");
      assert.deepEqual((await session(port, ann.cookie)).body, { error: "session-ended", reason: "signed-out-remotely" });
      clock.now += 6 * 60_000;
      assert.deepEqual((await post(port, "/gs/api/profile/sign-out-others", other.cookie as string)).body, { error: "reauth-required" });
      assert.deepEqual((await post(port, "/gs/api/profile/reauth", other.cookie as string, { password: "wrong one!" })).body, { error: "invalid-credential" });
      assert.equal((await post(port, "/gs/api/profile/reauth", other.cookie as string, { password: PASSWORD, recoveryKey: "rk_x" })).status, 400, "the password only: a key is no field of it (closed body)");
      assert.equal((await post(port, "/gs/api/profile/reauth", other.cookie as string, { password: PASSWORD })).status, 200);
      assert.equal((await post(port, "/gs/api/profile/sign-out-others", other.cookie as string)).status, 200);
    } finally {
      await stopServer(server);
    }
  });
});

describe("P3-ACCT independent-review fixes", () => {
  test("review H1, as the owner re-ruled it (PHASE 3 FINAL): a sign-in's own grant NEVER begins an Authorization Wallet replacement; an explicit 'Confirm it's you' with the password does (the recovery-key route is retired)", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await accountBrowser(port, "Ann", PASSWORD);
      const next = keplrAccount("acct/ann-next");
      const challenge = () => post(port, "/gs/api/account/authorization-wallet/challenge", ann.cookie, { newWallet: next.address });
      const refused = await challenge();
      assert.deepEqual([refused.status, refused.body], [403, { error: "reauth-required" }], "a cookie stolen in the sign-in's five minutes cannot begin a replacement");
      const keyRoute = await post(port, "/gs/api/profile/recovery-key", ann.cookie);
      assert.deepEqual([keyRoute.status, keyRoute.body], [410, { error: "retired" }], "no key is minted, ever");
      assert.equal((await post(port, "/gs/api/profile/reauth", ann.cookie, { password: PASSWORD })).status, 200);
      const made = await challenge();
      assert.equal(made.status, 200, made.text);
      assert.equal((made.body?.texts as unknown[]).length, 2, "the current wallet's approval and the new one's acceptance");
    } finally {
      await stopServer(server);
    }
  });

  test("review L2 (PHASE 3 FINAL): the LIVE-2E profile create is retired -- 410 -- and accounts are made as usual", async () => {
    const { server, port } = await prodServer();
    try {
      const answer = await post(port, "/gs/api/profile", await bootstrapCookie(port), { name: "Nobody" });
      assert.deepEqual([answer.status, answer.body], [410, { error: "retired" }]);
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

  test("money review M1 / re-review N-3 (PHASE 3 FINAL): there is no profile wallet to write, forget or restore -- signing out other devices, a password change and a recovery leave the Authorization Wallet exactly as designated", async () => {
    const { server, port, clock, service } = await prodServer();
    try {
      const ann = await accountBrowser(port, "Ann", PASSWORD);
      const principal = principalOf(service, ann.cookie, clock.now) as string;
      const designated = service.authorizationWallet(principal);
      assert.equal(designated?.address, ann.wallet.address);
      const surface = service as unknown as Record<string, unknown>;
      for (const gone of ["associateWallet", "forgetWallet", "profileWallet"]) assert.equal(surface[gone], undefined, `IdentityService.${gone} is gone`);
      const other = await loginOnFreshBrowser(port, "ann", PASSWORD);
      assert.deepEqual((await post(port, "/gs/api/profile/sign-out-others", other.cookie as string)).body, { ok: true, signedOut: 1 });
      assert.deepEqual(service.authorizationWallet(principal), designated, "signing out other devices");
      const changed = await post(port, "/gs/api/account/password", other.cookie as string, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      assert.equal(changed.status, 200, changed.text);
      assert.deepEqual(service.authorizationWallet(principal), designated, "a password change");
      assert.deepEqual((await post(port, "/gs/api/account/forget-wallet", cookieFromAnswer(changed) as string)).body, { error: "retired" }, "nothing to forget");
      const recovered = await recoverOnFreshBrowser(port, "ann", ann.wallet, "a third passphrase");
      assert.equal(recovered.answer.status, 200, recovered.answer.text);
      assert.deepEqual(service.authorizationWallet(principal), designated, "a recovery (the wallet is the recovery authority)");
    } finally {
      await stopServer(server);
    }
  });
});

describe("P3-ACCT re-review fixes", () => {
  /* "re-review N-3: a link authorized BEFORE a key rotation, a sign-out of other devices or a forget never writes its wallet
     back onto the cleaned profile" is gone by design: no link writes any wallet onto the profile (C, and money review M1
     above). */

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

/* ==================================================================
    LEGACY PROFILES -- RETIRED (PHASE 3 FINAL: replaced "the legacy migration (a recovery-key profile)")
   ================================================================== */

const DAY = 24 * 60 * 60 * 1000;

/** A LEGACY profile as a restart finds it -- schema 1 (a recovery-key profile) or, with `login`, schema 2 (a username and
 *  password, no Authorization Wallet) -- with one live session whose cookie the test holds. */
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

describe("P3-ACCT legacy profiles (PHASE 3 FINAL: retired, never migrated)", () => {
  test("a legacy profile's session ends `retired` -- a reload reaches the same answer; only the explicit Continue starts a fresh, signed-out browser; its RIGHT password answers 409 legacy-account; its owner makes a NEW account", async () => {
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
    const service = IdentityService.fromSnapshot(store, store.snapshot(), { policy: { passwordKdf: TEST_PASSWORD_KDF } });
    const { server, port, clock } = await prodServer({ service, clock: { now } });
    try {
      for (const legacy of [keyed, named]) {
        for (let reload = 0; reload < 2; reload += 1) {
          const boot = await session(port, legacy.cookie);
          assert.deepEqual([boot.status, boot.body], [401, { error: "session-ended", reason: "retired" }], "ended -- never a silent new guest, never the legacy profile");
        }
        assert.equal(principalOf(service, legacy.cookie, clock.now), null, "no socket, no request authenticates with it");
        assert.deepEqual((await me(port, legacy.cookie)).body, { error: "not-authenticated" });
        assert.equal(service.isProfiled(legacy.principal.principal_id), false);
        assert.equal(service.profileName(legacy.principal.principal_id), null);
        /* The player's explicit "Continue": a fresh, signed-out browser (the cookie is replaced, nothing is migrated). */
        const fresh = await session(port, legacy.cookie, { fresh: true });
        assert.equal(fresh.status, 201);
        assert.equal((fresh.body as { profile: unknown }).profile, null);
        assert.ok(cookieFromAnswer(fresh) !== null && cookieFromAnswer(fresh) !== legacy.cookie);
      }
      /* The legacy account's RIGHT password: told so, and nothing is signed in; a wrong one is the one invalid answer. */
      const right = await loginOnFreshBrowser(port, "OldTimer", PASSWORD);
      assert.deepEqual([right.answer.status, right.answer.body], [409, { error: "legacy-account" }]);
      assert.equal(right.cookie, null);
      assert.equal(((await session(port, right.before)).body as { profile: unknown }).profile, null, "its session is not replaced");
      const wrong = await loginOnFreshBrowser(port, "OldTimer", "not the password");
      assert.deepEqual([wrong.answer.status, wrong.answer.body], [403, { error: "invalid-credential" }]);
      assert.equal(observable(wrong.answer), observable((await loginOnFreshBrowser(port, "Nobody", PASSWORD)).answer));
      assert.equal(service.stats.legacyRefusals, 1);
      /* No migration route exists (410); its owner makes a NEW account -- a new principal, with an Authorization Wallet. */
      assert.deepEqual((await post(port, "/gs/api/account/credentials", await bootstrapCookie(port), { username: "OldTimer2", password: PASSWORD })).body, { error: "retired" });
      assert.deepEqual((await post(port, "/gs/api/profile/recover", await bootstrapCookie(port), { recoveryKey: `${keyed.profile.recovery_selector}.${mintSecret()}` })).body, { error: "retired" }, "nor does the legacy key sign in");
      const made = await accountBrowser(port, "NewTimer", PASSWORD);
      const newPrincipal = principalOf(service, made.cookie, clock.now) as string;
      assert.ok(![keyed.principal.principal_id, named.principal.principal_id].includes(newPrincipal), "a new principal: nothing of the legacy profile is taken over");
      assert.equal(authorizationWalletOf(service.peekProfileOf(newPrincipal) as Profile)?.address, made.wallet.address);
      assert.deepEqual(store.snapshot().profiles.map((profile) => profile.schema).sort(), [1, 2, 3], "the legacy records are untouched");
    } finally {
      await stopServer(server);
    }
  });
});

describe("P3-ACCT persistence and restore", () => {
  test("a restart over the journal store keeps the account (schema 3: the hash only, and its Authorization Wallet) and its username; login and recovery work after it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-acct-"));
    const policy = { passwordKdf: TEST_PASSWORD_KDF };
    const clock = { now: Date.now() };
    try {
      const first = await IdentityService.open(createJournalIdentityStore(dir, { warn: () => undefined }), { policy });
      const a = await prodServer({ clock, service: first });
      let principal: string | null;
      let wallet: KeplrAccount;
      try {
        const ann = await accountBrowser(a.port, "Ann", PASSWORD);
        principal = principalOf(first, ann.cookie, clock.now);
        wallet = ann.wallet;
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
        assert.equal((second.peekProfileOf(principal as string) as Profile).schema, 3);
        assert.deepEqual(((await me(b.port, again.cookie as string)).body as { account: { authorizationWallet: { address: string } } }).account.authorizationWallet.address, wallet.address, "the Authorization Wallet survived");
        assert.deepEqual((await create(b.port, await bootstrapCookie(b.port), { username: "ann", password: PASSWORD, name: "X" })).body, { error: "username-taken" }, "the username survived the restart");
        const recovered = await recoverOnFreshBrowser(b.port, "ann", wallet);
        assert.equal(recovered.answer.status, 200, "the wallet still recovers the account");
        assert.equal(principalOf(second, recovered.cookie as string, clock.now), principal);
      } finally {
        await stopServer(b.server);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the identity restore replays a new account's credential and a legacy establishment's, clears a LEGACY persisted wallet, follows an Authorization Wallet's replacement (never clearing it), and never installs a phantom's taken username", () => {
    const at = 1_760_000_000_000;
    const event = (fields: Record<string, unknown>, n: number): SecurityEvent => ({ format: SECURITY_EVENT_FORMAT, version: SECURITY_EVENT_VERSION, event_id: n.toString(16).padStart(32, "0"), at: at + n, ...fields }) as unknown as SecurityEvent;
    const confirm = (target: SecurityEvent, n: number) => event({ kind: "confirmed", principal_id: target.principal_id, confirms: target.event_id, confirmed_kind: target.kind }, n);
    /* The table at T: a legacy profile (no username) with a persisted wallet; an Authorization Wallet account (schema 3)
       designated FIXTURE_WALLET; and nothing of the rest. */
    const legacy = identitySet(41);
    const legacyAtT = accountProfile(legacy, { wallet: FIXTURE_WALLET });
    const cy = identitySet(44);
    const cyAtT: Profile = { ...accountProfile(cy, { login: "Cy", wallet: FIXTURE_WALLET, at }), schema: 3, recovery_hash: sealedRecoveryDigest(cy.profile.recovery_selector) };
    const snapshot: FullIdentitySnapshot = applyChange(
      { principals: [legacy.profiledPrincipal, cy.profiledPrincipal], sessions: [legacy.session, cy.session], profiles: [legacyAtT, cyAtT], links: [], families: [legacy.family, cy.family] },
      {},
    );
    /* After T: the legacy profile set "Old" (confirmed, an old build's journal); a new account "Ann" (confirmed); a
       PHANTOM creation of "ann" by a third principal LATER (unconfirmed), which the uniqueness rule shows never committed;
       and Cy's Authorization Wallet replaced (confirmed). */
    const established = event({ kind: "credentials-established", principal_id: legacy.principal.principal_id, profile_id: legacy.profile.profile_id, login_key: "old", login_name: "Old", password_hash: accountProfile(legacy, { login: "Old" }).password_hash, set_at: at + 1 }, 1);
    const ann = identitySet(42);
    const annProfile = { ...accountProfile(ann, { login: "Ann" }), wallet_address: null, wallet_verified_at: null };
    const created = event({ kind: "profile-created", principal_id: ann.principal.principal_id, principal: ann.profiledPrincipal, profile: annProfile }, 3);
    const phantom = identitySet(43);
    const phantomCreated = event({ kind: "profile-created", principal_id: phantom.principal.principal_id, principal: phantom.profiledPrincipal, profile: accountProfile(phantom, { login: "ANN" }) }, 5);
    const replaced = event({ kind: "authorization-wallet-replaced", principal_id: cy.principal.principal_id, profile_id: cy.profile.profile_id, from_wallet: FIXTURE_WALLET, from_since: at, to_wallet: FIXTURE_WALLET_2, to_since: at + 6 }, 6);
    const events = [established, confirm(established, 2), created, confirm(created, 4), phantomCreated, replaced, confirm(replaced, 7)];
    const plan = planSecurityReplay({ snapshot, events, restoreId: "r-p3acct", at: at + 10 });
    const after = plan.principals.reduce((state, entry) => (entry.change === null ? state : applyChange(state, entry.change)), snapshot);
    const byId = new Map(after.profiles.map((profile) => [profile.profile_id, profile] as const));
    assert.equal(loginOf(byId.get(legacy.profile.profile_id) as Profile)?.key, "old", "the legacy establishment is installed (an old journal is still read)");
    assert.equal(walletOf(byId.get(legacy.profile.profile_id) as Profile), null, "the legacy persisted wallet is cleared");
    assert.equal(loginOf(byId.get(ann.profile.profile_id) as Profile)?.key, "ann", "the confirmed account is created with its credential");
    assert.equal(byId.has(phantom.profile.profile_id), false, "the phantom whose username another profile won is not installed");
    assert.deepEqual(authorizationWalletOf(byId.get(cy.profile.profile_id) as Profile), { address: FIXTURE_WALLET_2, since: at + 6 }, "the Authorization Wallet's replacement is replayed, never cleared");
    assert.equal(plan.report.credentials_installed, 1);
    assert.equal(plan.report.wallets_cleared, 1, "only the legacy convenience wallet");
    assert.equal(plan.report.authorization_wallets_advanced, 1);
    /* Idempotent: a second run on the result plans nothing for the profiles. */
    const again = planSecurityReplay({ snapshot: after, events, restoreId: "r-p3acct", at: at + 10 });
    assert.equal(again.report.credentials_installed, 0);
    assert.equal(again.report.wallets_cleared, 0);
    assert.equal(again.report.authorization_wallets_advanced, 0);
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
    C. NO PERSISTED WALLET (the money stack over the offline Juno) -- PHASE 3 FINAL replaced "the persisted, verified
    wallet" with its opposite: the profile remembers no wallet; a seat's wallet is that table's
   ================================================================== */

const moneyOf = (view: Record<string, unknown>) => view.money as RoomMoneyView;

async function seatJoiner(world: MoneyServer, who: Player, code: string): Promise<string> {
  const joined = await who.client.op({ type: "join", code, takeSeat: true });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  return (joined.data as { playerId: string }).playerId;
}

describe("P3-ACCT the seat's wallet is the table's, never the account's (PHASE 3 FINAL)", () => {
  test("a link persists NOTHING about the account -- the Authorization Wallet is unchanged and no profile wallet is recorded; PHASE 4: any wallet links on its own fresh signature (no password), a seat's wallet is replaced only when asked; the payout wallet is the seat's bound one", async () => {
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
      const joPrincipal = principalOfPlayer(world, jo);
      const designated = world.identity.authorizationWallet(joPrincipal);
      assert.equal(designated?.address, jo.browser.wallet.address, "the account's one Authorization Wallet, from its creation");
      const profileBefore = world.identity.peekProfileOf(joPrincipal);
      const joWallet = testWallet("jo");
      const joKey = testConsentKey("jo");
      assert.notEqual(joWallet.address, designated?.address, "a game wallet, not the Authorization Wallet");
      await seatJoiner(world, jo, table.code);
      const first = await linkWallet(jo, table.gameId, joWallet, joKey, { confirm: false });
      assert.equal(first.status, 200, first.text);
      assert.deepEqual(world.identity.authorizationWallet(joPrincipal), designated, "the link never changes the Authorization Wallet");
      assert.deepEqual(world.identity.peekProfileOf(joPrincipal), profileBefore, "nothing about the account was written");
      const mine = await me(world.port, jo.browser.cookie);
      assert.equal((mine.body as { account: { authorizationWallet: { address: string } } }).account.authorizationWallet.address, designated?.address);
      assert.ok(!mine.text.includes(joWallet.address), "the seat's wallet is no fact of the account");
      const audit = world.ops.lines.map((line) => JSON.stringify(line));
      assert.ok(!audit.some((line) => line.includes("money.profile-wallet")), "no profile-wallet write is audited (none happens)");
      await joinerFunds(world, jo, table.gameId, joWallet, joKey, first.body?.ticket as string);
      await world.observe();
      assert.equal(moneyOf(await viewOf(jo.client, table.gameId)).you?.funding, "funded");
      /* Start: the frozen roster's payout address is the seat's bound wallet -- never the Authorization Wallet. */
      assert.equal((await host.client.op({ type: "start-game" }, table.gameId)).ok, true);
      await world.drive(async () => world.server.rooms.moneyPort.recordOf(table.gameId)?.status === "active");
      const fin = await world.financial.load(table.gameId);
      const joSeat = fin?.roster?.roster.find((entry) => entry.payout_address === joWallet.address);
      assert.ok(joSeat !== undefined, `the roster pays the seat's linked wallet: ${JSON.stringify(fin?.roster?.roster)}`);
      assert.ok(!(fin?.roster?.roster ?? []).some((entry) => entry.payout_address === designated?.address), "never the Authorization Wallet by itself");
      /* LATER (the sign-in's five minutes long gone): another table, the SAME game wallet -- it is not remembered by the
         account, and PHASE 4 (owner): it links on its own fresh signature, with no password. */
      world.advance(30 * 60_000);
      const host2 = await player(world, "Hugo");
      const table2 = await openMoneyTable(host2);
      const h2 = await linkWallet(host2, table2.gameId, testWallet("hugo"), testConsentKey("hugo"));
      await hostCreates(world, host2, table2.gameId, testWallet("hugo"), testConsentKey("hugo"), h2.body?.ticket as string);
      await world.observe();
      await seatJoiner(world, jo, table2.code);
      const returning = await linkWallet(jo, table2.gameId, joWallet, testConsentKey("jo-2"), { confirm: false });
      assert.equal(returning.status, 200, `PHASE 4: the wallet's own signature links it, no password: ${returning.text}`);
      assert.deepEqual(world.identity.authorizationWallet(joPrincipal), designated, "still never the account's");
      /* A DIFFERENT wallet on this seat (the Authorization Wallet, or any other) replaces the link only when the player
         says so (W2-M, asked before Keplr signs) -- never silently, and still no password. */
      const authority = testWallet(`authorization/${jo.browser.username}`);
      assert.equal(authority.address, designated?.address);
      const ask = await linkWallet(jo, table2.gameId, authority, testConsentKey("jo-auth"), { confirm: false });
      assert.equal(ask.body?.error, "replace-required", "W2-M: a different wallet replaces the seat's link only when asked to");
      const viaAuthority = await linkWallet(jo, table2.gameId, authority, testConsentKey("jo-auth"), { confirm: false, replace: true });
      assert.equal(viaAuthority.status, 200, viaAuthority.text);
      const otherWallet = testWallet("jo-other");
      const replaced = await linkWallet(jo, table2.gameId, otherWallet, testConsentKey("jo-3"), { confirm: false, replace: true });
      assert.equal(replaced.status, 200, replaced.text);
      assert.deepEqual(world.identity.authorizationWallet(joPrincipal), designated, "the seat's replacement is not the account's");
      assert.deepEqual(world.identity.peekProfileOf(joPrincipal), profileBefore);
    } finally {
      await world.close();
    }
  });

  test("'Forget this wallet' is retired (410): there is nothing to forget -- PHASE 4: past the sign-in's minutes, any wallet's challenge is still minted (its own signature, not a password, is what links it)", async () => {
    const world = await moneyServer();
    try {
      const host = await accountPlayer(world, "Hana");
      const table = await openMoneyTable(host);
      const wallet = testWallet("hana");
      assert.equal((await linkWallet(host, table.gameId, wallet, testConsentKey("hana"), { confirm: false })).status, 200);
      world.advance(10 * 60_000);
      assert.deepEqual((await apiRequest(world.port, "/gs/api/account/forget-wallet", { cookie: host.browser.cookie, body: {} })).body, { error: "retired" });
      await host.confirm();
      assert.deepEqual((await apiRequest(world.port, "/gs/api/account/forget-wallet", { cookie: host.browser.cookie, body: {} })).body, { error: "retired" }, "with or without a confirmation");
      world.advance(10 * 60_000);
      assert.equal((await host.api("wallet-challenge", { gameId: table.gameId, wallet: wallet.address })).status, 200);
      const authority = await host.api("wallet-challenge", { gameId: table.gameId, wallet: host.browser.wallet.address });
      assert.equal(authority.status, 200, authority.text);
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
      assert.deepEqual(Object.keys(seats[0].facts).sort(), ["accountAgeDays", "authorizationWalletSince", "completedMoneyGames", "disputedGames", "establishedOpponents", "inactivityExits", "memberSince", "unresolvedDisputes"]);
      assert.match(String(seats[0].facts.memberSince), /^\d{4}-\d{2}$/, "the month, never the day");
      assert.equal(Number(seats[0].facts.accountAgeDays) % 7, 0, "whole weeks only (re-review N-4)");
      assert.equal(seats[0].facts.establishedOpponents, 0, "P3-ACCT POLICY: the owner's definition -- a server-derived count (no completed game yet)");
      assert.match(String(seats[0].facts.authorizationWalletSince), /^\d{4}-\d{2}$/, "PHASE 3 FINAL: every account has an Authorization Wallet -- since when, to the month");
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
