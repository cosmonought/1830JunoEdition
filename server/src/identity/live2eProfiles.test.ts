// server/src/identity/live2eProfiles.test.ts
//
// ==================================================================
//  LIVE-2E: MANDATORY PROFILES, AGAINST THE REAL SERVER (PHASE 3 FINAL: AUTHORIZATION WALLET ACCOUNTS)
// ==================================================================
//
// A PROFILE (application identity, mandatory to play) controls exactly one durable PRINCIPAL, which any number of
// SESSIONS (devices) authenticate, and which owns GameRecord seats. These suites drive `createGameServer` in production
// mode over real HTTP and real WebSockets, with real cookies and an allowed Origin, as a browser does:
//   - creation: the cleaned name, the account's ONE Authorization Wallet (no recovery key: a sealed digest), a FRESH
//     session cookie, no id on the wire, and one profile per principal however many tabs press "Create" at once;
//   - the unprofiled principal: bootstrap `profile: null`, the profiled actions 403 `profile-required`, and -- P3-ACCT
//     (owner, 2026-10-05: public first) -- a PUBLIC, READ-ONLY socket (no longer an upgrade 403): the per-frame
//     allow-list answers only the public reads and refuses everything else `profile-required`;
//   - "Forgot password?" by the Authorization Wallet: a fresh session for the SAME principal (so the same seats), the
//     browser's temporary session `replaced`, every earlier session of the account ended, one indistinguishable answer
//     for every wrong proof; a second device signs in with the username and password;
//   - rotation, "sign out this device", "sign out other devices" -- and their sockets closing 4401;
//   - persistence: a restart over the file store keeps all of it; a v1 file migrates; a half-bound profile refuses to
//     load; an injected store failure changes nothing;
//   - the recovery and creation budgets; nothing secret printed;
//   - SEAT CONTINUITY: one seat across two devices, a sign-out, a restart and a recovery -- nothing copied or moved.
// PHASE 3 FINAL retired the LIVE-2E recovery key and "Link another device" codes: their routes answer 410 `retired`.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { WebSocket } from "ws";

import { createFileLogStore, type LogStore } from "../fileLogStore";
import type { IdentityLimits, RoomLimits } from "../ingress/limits";
import { DEFAULT_INGRESS_LIMITS } from "../ingress/limits";
import { createFileRecordStore, createMemoryRecordStore, type RecordStore } from "../rooms/recordStore";
import {
  ALICE,
  BOB,
  BUY,
  Client,
  DEV_ORIGIN,
  PROD_ORIGIN,
  apiRequest,
  bootstrapCookie,
  cookieFromAnswer,
  createAuthorization,
  devIdentity,
  loginOnFreshBrowser,
  profiledBrowser,
  quietConsole,
  seededRecord,
  sessionIdOfCookie,
  sleep,
  startServer,
  stopServer,
  until,
  type ApiAnswer,
  type ProfiledBrowser,
} from "../rooms/testSupport";
import { TEST_PASSWORD_KDF } from "../escrow/escrow4Support";
import { keplrAccount, type KeplrAccount } from "../testSupport/authorizationWallets";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { hashPassword, sealedRecoveryDigest } from "./accountCredentials";
import { decideUpgrade, type UpgradeGate } from "./authenticateUpgrade";
import { readSessionCookie } from "./cookies";
import { createFileIdentityStore, IDENTITY_FILE, IDENTITY_FILE_VERSION } from "./fileStore";
import { linkCodeHash, mintPrincipalId, mintProfileId, mintRecoverySelector, mintSecret, mintSessionId, secretHash } from "./ids";
import { IdentityLimiter } from "./limiter";
import { IdentityService } from "./sessions";
import { createMemoryIdentityStore, IdentityStoreCorruptError, type MemoryIdentityStore, type Profile } from "./store";

quietConsole();

const DAY = 24 * 60 * 60 * 1000;
/** `profiledBrowser`'s password, and the ones a recovery or a change sets. */
const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "a brand new passphrase";
const POLICY = { passwordKdf: TEST_PASSWORD_KDF };

/* ==================================================================
    FIXTURES
   ================================================================== */

interface Clock {
  now: number;
}

/** A production server: cookies, `/gs`, the allowed Origin, and a clock the test may step. Every identity budget is
 *  wide (testSupport's roomy limits) unless `limits` narrows one. The identity uses the cheap test KDF. */
async function prodServer(
  over: { clock?: Clock; service?: IdentityService; limits?: Partial<IdentityLimits>; rooms?: Partial<RoomLimits>; records?: RecordStore; store?: LogStore } = {},
) {
  const clock = over.clock ?? { now: Date.now() };
  const service = over.service ?? IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] }, { policy: POLICY });
  const started = await startServer({
    identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, now: () => clock.now, service },
    ...(over.records ? { records: over.records } : {}),
    ...(over.store ? { store: over.store } : {}),
    limits: { identity: { ...(over.limits ?? {}) }, rooms: { ...(over.rooms ?? {}) } },
  });
  return { ...started, clock };
}

/** An in-memory identity service whose store the test can read and fail. */
function memoryService(): { service: IdentityService; store: MemoryIdentityStore } {
  const store = createMemoryIdentityStore();
  return { store, service: IdentityService.fromSnapshot(store, { principals: [], sessions: [] }, { policy: POLICY }) };
}

const post = (port: number, pathname: string, cookie?: string, body: object = {}) => apiRequest(port, pathname, { cookie, body });
const session = (port: number, cookie?: string, body: object = {}) => post(port, "/gs/api/session", cookie, body);
const login = (port: number, cookie: string, username: string, password: string) => post(port, "/gs/api/account/login", cookie, { username, password });
const changePassword = (port: number, cookie: string, currentPassword: string, newPassword: string) => post(port, "/gs/api/account/password", cookie, { currentPassword, newPassword });
/* ESCROW-3A (brief §10B): signing out other devices is SENSITIVE -- a recent sign-in, or "Confirm it's you" with the
   account's PASSWORD (PHASE 3 FINAL: no recovery key exists). `password`, when given, confirms first. */
const reauth = (port: number, cookie: string, password: string) => post(port, "/gs/api/profile/reauth", cookie, { password });
const signOutOthers = async (port: number, cookie: string, password?: string) => {
  if (password !== undefined) assert.equal((await reauth(port, cookie, password)).status, 200, "re-authenticated");
  return post(port, "/gs/api/profile/sign-out-others", cookie);
};
const signOut = (port: number, cookie: string) => post(port, "/gs/api/session/revoke", cookie);

/** Create an account on this browser: the CREATE text for the username, signed by `wallet`, then the create. */
async function createAccount(port: number, cookie: string, input: { username: string; password?: string; name: unknown; wallet: KeplrAccount }): Promise<ApiAnswer> {
  const proof = await createAuthorization(port, cookie, input.username, input.wallet);
  return post(port, "/gs/api/account/create", cookie, { username: input.username, password: input.password ?? PASSWORD, name: input.name, ...proof });
}

/** "Forgot password?" on this browser: the RECOVER text for (username, wallet), signed by `signer` (normally the wallet
 *  itself) -- or by `forge` -- then the recovery. A refused mint is answered as it came. */
async function recover(
  port: number,
  cookie: string,
  input: { username: string; wallet: KeplrAccount; signer?: KeplrAccount; forge?: (text: string) => { pubKey: string; signature: string }; newPassword?: string },
): Promise<ApiAnswer & { signed?: { pubKey: string; signature: string } }> {
  const minted = await post(port, "/gs/api/account/authorization", cookie, { purpose: "recover", username: input.username, wallet: input.wallet.address });
  if (minted.status !== 200) return minted;
  const text = (minted.body?.texts as Array<{ text: string }>)[0].text;
  const signed = input.forge !== undefined ? input.forge(text) : (input.signer ?? input.wallet).sign(text);
  const answer = await post(port, "/gs/api/account/recover", cookie, { operation: minted.body?.operation, ...signed, newPassword: input.newPassword ?? NEW_PASSWORD });
  return { ...answer, signed };
}

/** A fresh browser recovers an account; its new cookie on success. */
async function recoverOnFreshBrowser(port: number, input: Parameters<typeof recover>[2]): Promise<{ answer: ApiAnswer; before: string; cookie: string | null; signed?: { pubKey: string; signature: string } }> {
  const before = await bootstrapCookie(port);
  const answer = await recover(port, before, input);
  return { answer, before, cookie: answer.status === 200 ? cookieFromAnswer(answer) : null, signed: answer.signed };
}

/** "Change Authorization Wallet": Confirm it's you (the password), the two texts, the CURRENT wallet approves, the NEW one
 *  accepts. */
async function replaceAuthorizationWallet(port: number, browser: { cookie: string; password: string }, current: KeplrAccount, next: KeplrAccount): Promise<ApiAnswer> {
  assert.equal((await reauth(port, browser.cookie, browser.password)).status, 200);
  const challenge = await post(port, "/gs/api/account/authorization-wallet/challenge", browser.cookie, { newWallet: next.address });
  assert.equal(challenge.status, 200, challenge.text);
  const texts = challenge.body?.texts as Array<{ text: string }>;
  const approve = current.sign(texts[0].text);
  const accept = next.sign(texts[1].text);
  return post(port, "/gs/api/account/authorization-wallet/replace", browser.cookie, {
    operation: challenge.body?.operation,
    approvePubKey: approve.pubKey,
    approveSignature: approve.signature,
    acceptPubKey: accept.pubKey,
    acceptSignature: accept.signature,
  });
}

/** What the bootstrap names: a signed-in account by its name, its other sessions and its username -- never an id. */
const profileOf = (browser: Pick<ProfiledBrowser, "name" | "username">, otherSessions: number) => ({ name: browser.name, otherSessions, username: browser.username });

/** A response as a client can observe it -- status, headers (less the clock and the connection) and body -- so two
 *  refusals can be compared for sameness. */
function observable(answer: ApiAnswer): string {
  const { date: _date, connection: _connection, "keep-alive": _keepAlive, ...headers } = answer.headers;
  return JSON.stringify({ status: answer.status, headers, text: answer.text });
}

/** The status of a production socket upgrade; an accepted socket is closed at once. */
function upgradeStatus(port: number, cookie?: string, origin: string = PROD_ORIGIN): Promise<number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/gs`, { headers: cookie ? { Cookie: cookie } : {}, origin });
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

const principalOf = (server: { identity: IdentityService }, cookie: string, now = Date.now()): string | null => {
  const auth = server.identity.authenticate(readSessionCookie(cookie), now);
  return auth.kind === "ok" ? auth.principalId : null;
};

type WireView = { hostId: string; players: Array<{ id: string; nickname: string }>; you: { role: string; playerId: string | null } };
const viewIn = (client: Client, gameId: string): WireView | undefined =>
  client.frames.filter((frame) => frame.kind === "room" && frame.gameId === gameId).map((frame) => frame.view as WireView).pop();

const CREATE = (over: Record<string, unknown> = {}) => ({ type: "create", visibility: "public", exactPlayers: null, variants: {}, nickname: "", ...over });

/** A table the profile behind `cookie` creates (seat 1, the host). */
async function tableOf(port: number, cookie: string, label: string): Promise<{ gameId: string; code: string; playerId: string }> {
  const client = await Client.openWithCookie(port, cookie, label);
  const created = await client.op(CREATE());
  assert.equal(created.ok, true, JSON.stringify(created));
  await client.close();
  return created.data as { gameId: string; code: string; playerId: string };
}

/** The view a socket opened with `cookie` gets of `gameId`. */
async function viewWith(port: number, cookie: string, gameId: string, label: string): Promise<WireView> {
  const client = await Client.openWithCookie(port, cookie, label);
  client.roomHello(gameId);
  await client.next((frame) => frame.kind === "room" || frame.kind === "error", `${label}'s view`);
  const view = viewIn(client, gameId);
  await client.close();
  assert.ok(view, `${label} got a view`);
  return view as WireView;
}

const tmpDir = (tag: string) => fs.mkdtempSync(path.join(os.tmpdir(), `live2e-${tag}-`));
const readIdentityFile = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, IDENTITY_FILE), "utf8")) as Record<string, unknown> & { version: number };

/** A production server over the file stores in `dir` -- identity, game records and logs, as `start.ts` wires them (a
 *  restart is another call over the same directory). */
async function fileServer(dir: string, clock?: Clock) {
  const service = await IdentityService.open(createFileIdentityStore(dir, { warn: () => undefined }), { policy: POLICY });
  return prodServer({ service, records: createFileRecordStore(dir), store: await settledLogStore(dir), ...(clock ? { clock } : {}) });
}

/** A file log store whose own (un-awaited) directory creation has settled -- so a test that removes the directory
 *  at its end cannot race it into an unhandled rejection. */
async function settledLogStore(dir: string): Promise<LogStore> {
  const store = createFileLogStore(dir, { warn: () => undefined });
  if (store.loadChat) await store.loadChat("settle");
  return store;
}

/* ==================================================================
    CREATION
   ================================================================== */

describe("LIVE-2E create (PHASE 3 FINAL: an account with its Authorization Wallet)", () => {
  test("the name is cleaned; the account is stored with its Authorization Wallet and NO recovery key (a sealed digest); a FRESH cookie; no id on the wire", async () => {
    const { service, store } = memoryService();
    const { server, port } = await prodServer({ service });
    try {
      const cookie = await bootstrapCookie(port);
      const wallet = keplrAccount("live2e/create/ann");
      // Refused names: nothing usable, or not a name at all -- and neither spends anything durable.
      for (const [name, error] of [["", "bad-name"], ["   \t  ", "bad-name"], ["\u0000\u0007", "bad-name"]] as const) {
        const refused = await createAccount(port, cookie, { username: "ann.lee", name, wallet });
        assert.deepEqual([refused.status, refused.body], [400, { error }], JSON.stringify(name));
      }
      for (const name of [42, null, "x".repeat(257)]) assert.deepEqual((await createAccount(port, cookie, { username: "ann.lee", name, wallet })).body, { error: "bad-request" });
      assert.equal(store.snapshot().profiles.length, 0);

      const created = await createAccount(port, cookie, { username: "ann.lee", name: "  Ann\u0007   \t Lee  with a much too long surname  ", wallet });
      assert.equal(created.status, 201, created.text);
      assert.equal(created.headers["cache-control"], "no-store");
      /* PHASE 3 FINAL: the account is signed in on a FRESH session (session fixation); the temporary one is replaced. */
      const fresh = cookieFromAnswer(created) as string;
      assert.ok(fresh !== null && fresh !== cookie, "a fresh session cookie");
      assert.deepEqual((await session(port, cookie)).body, { error: "session-ended", reason: "replaced" });
      const body = created.body as { ok: boolean; profile: { name: string; otherSessions: number }; username: string };
      // Control characters dropped, whitespace collapsed, cut to 24 characters, trimmed again.
      assert.deepEqual(body.profile, { name: "Ann Lee with a much too", otherSessions: 0 });
      assert.deepEqual(Object.keys(body).sort(), ["ok", "profile", "username"], "no recovery key: none exists");
      assert.ok(!/pr_|pf_|se_|rk_/.test(created.text), "no principal, profile or session id (and no key) on the wire");

      // Stored: the Authorization Wallet the CREATE text's signature proved, the scrypt hash, and the SEALED digest of
      // the internal credential epoch -- no key can match it.
      const snapshot = store.snapshot();
      assert.equal(snapshot.profiles.length, 1);
      const [profile] = snapshot.profiles;
      assert.equal(profile.schema, 3);
      assert.equal(profile.wallet_address, wallet.address, "its Authorization Wallet");
      assert.equal(profile.recovery_hash, sealedRecoveryDigest(profile.recovery_selector), "no recovery key: the sealed digest");
      assert.equal(profile.display_name, body.profile.name);
      assert.match(profile.profile_id, /^pf_/);
      assert.ok(!JSON.stringify(snapshot).includes(PASSWORD), "no plaintext password in the store");
      // Bound both ways, in the same commit: the principal is durable and names the profile.
      const principal = snapshot.principals.find((record) => record.principal_id === profile.principal_id);
      assert.deepEqual([principal?.kind, principal?.account_link], ["profile", profile.profile_id]);
      assert.equal(principal?.principal_id, principalOf(server, fresh));

      // The bootstrap now names the profile -- by name and username only.
      const again = await session(port, fresh);
      assert.deepEqual(again.body, { ok: true, expiresAt: (again.body as { expiresAt: number }).expiresAt, profile: { name: body.profile.name, otherSessions: 0, username: "ann.lee" } });
      assert.ok(!/pr_|pf_|se_|rk_/.test(again.text));
      // Created once: a second attempt is told so (the CREATE text is not even minted), and makes nothing.
      const twice = await post(port, "/gs/api/account/authorization", fresh, { purpose: "create", username: "somebody.else", wallet: keplrAccount("live2e/create/other").address });
      assert.deepEqual([twice.status, twice.body], [409, { error: "already-profiled" }], "a signed-in browser is refused the CREATE text");
      const forced = await post(port, "/gs/api/account/create", fresh, { username: "somebody.else", password: PASSWORD, name: "Somebody Else", operation: "0".repeat(32), pubKey: "", signature: "" });
      assert.deepEqual([forced.status, forced.body], [409, { error: "already-profiled", profile: { name: body.profile.name } }]);
      assert.equal(store.snapshot().profiles.length, 1);
      // No cookie is not an account request at all.
      assert.deepEqual((await post(port, "/gs/api/account/create", undefined, { username: "nobody", password: PASSWORD, name: "Nobody" })).body, { error: "not-authenticated" });
    } finally {
      await stopServer(server);
    }
  });

  test("retry and race: five concurrent creates on one cookie make exactly one profile (one 201; the rest refused, none signed in); a second browser makes its own", async () => {
    const { service, store } = memoryService();
    const { server, port } = await prodServer({ service });
    try {
      const cookie = await bootstrapCookie(port);
      const wallet = keplrAccount("live2e/race/one");
      const proof = await createAuthorization(port, cookie, "race.one", wallet);
      const answers = await Promise.all(["One", "Two", "Three", "Four", "Five"].map((name) => post(port, "/gs/api/account/create", cookie, { username: "race.one", password: PASSWORD, name, ...proof })));
      const winners = answers.filter((answer) => answer.status === 201);
      assert.equal(winners.length, 1, answers.map((answer) => `${answer.status} ${answer.text}`).join(" | "));
      for (const loser of answers.filter((answer) => answer.status !== 201)) {
        /* The single-use CREATE operation is in use (or spent) -- or, once the winner has replaced this browser's
           temporary session, the cookie authenticates nothing. Never a second account, never a cookie. */
        assert.ok(
          (loser.status === 409 && (loser.body as { error: string }).error === "authorization-used") || (loser.status === 401 && (loser.body as { error: string }).error === "not-authenticated"),
          `${loser.status} ${loser.text}`,
        );
        assert.equal(loser.headers["set-cookie"], undefined);
      }
      assert.equal(store.snapshot().profiles.length, 1, "exactly one profile stored");
      assert.equal(service.stats.profilesCreated, 1);
      const winner = cookieFromAnswer(winners[0]) as string;

      const other = await profiledBrowser(port, "Bea");
      const snapshot = store.snapshot();
      assert.equal(snapshot.profiles.length, 2);
      assert.notEqual(snapshot.profiles[0].principal_id, snapshot.profiles[1].principal_id, "a different principal");
      assert.notEqual(other.wallet.address, wallet.address, "its own Authorization Wallet");
      assert.notEqual(principalOf(server, other.cookie), principalOf(server, winner));
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    THE UNPROFILED PRINCIPAL
   ================================================================== */

describe("LIVE-2E the profile gate", () => {
  test("an unprofiled browser: bootstrap says profile null, its socket is a PUBLIC one (P3-ACCT: no failed-upgrade budget spent), the profiled actions are 403", async () => {
    const { server, port } = await prodServer({ limits: { failedUpgradesPerIp: { capacity: 4, refillPerSecond: 0.0001 } } });
    try {
      const guest = await bootstrapCookie(port);
      const boot = await session(port, guest);
      assert.equal(boot.status, 200);
      assert.equal((boot.body as { profile: unknown }).profile, null);
      for (let n = 0; n < 4; n += 1) assert.equal(await upgradeStatus(port, guest), 101, "P3-ACCT: a signed-out visitor opens a public, read-only socket");
      assert.equal(server.upgrades.refused["profile:403"], undefined);
      assert.equal(server.upgrades.accepted, 4);
      const actions: Array<[string, object]> = [
        ["/gs/api/profile/sign-out-others", {}],
        ["/gs/api/profile/reauth", { password: PASSWORD }],
        ["/gs/api/account/password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }],
        ["/gs/api/account/me", {}],
        ["/gs/api/account/authorization-wallet/challenge", { newWallet: keplrAccount("live2e/gate").address }],
      ];
      for (const [pathname, body] of actions) {
        const refused = await post(port, pathname, guest, body);
        assert.deepEqual([refused.status, refused.body], [403, { error: "profile-required" }], pathname);
      }
      // Without any session they are not-authenticated (the client bootstraps first).
      for (const [pathname, body] of actions) assert.deepEqual((await post(port, pathname, "", body)).body, { error: "not-authenticated" }, pathname);
      // PHASE 3 FINAL: the LIVE-2E recovery-key and link-code actions are retired for everybody.
      for (const pathname of ["/gs/api/profile/link-code", "/gs/api/profile/recovery-key"]) {
        const retired = await post(port, pathname, guest);
        assert.deepEqual([retired.status, retired.body], [410, { error: "retired" }], pathname);
      }
      // Nothing was charged to the address's failed-upgrade budget (capacity 4): a signed-in player there still opens.
      const player = await profiledBrowser(port, "Ann");
      assert.equal(await upgradeStatus(port, player.cookie), 101);
    } finally {
      await stopServer(server);
    }
  });

  test("decideUpgrade: P3-ACCT -- a principal without a profile passes step 5b (public, read-only) and meets the caps like any other -- in either mode", async () => {
    const limits = { ...DEFAULT_INGRESS_LIMITS.identity };
    const identity = IdentityService.fromSnapshot(createMemoryIdentityStore(), { principals: [], sessions: [] });
    const created = await identity.bootstrap({ kind: "none" }, false, 0);
    const cookie = (created.kind === "ok" ? (created.setCookie ?? "") : "").split(";")[0];
    const gate = (over: Partial<UpgradeGate> = {}): UpgradeGate => ({
      mode: "production",
      wsPath: "/gs",
      allowedOrigins: new Set([PROD_ORIGIN]),
      allowedOriginList: [PROD_ORIGIN],
      trustedProxyHops: 0,
      identity,
      devAuthenticator: null,
      limiter: new IdentityLimiter(limits, () => 0),
      limits,
      counts: { global: () => 0, forIp: () => 0, forAggregate: () => 0, forPrincipal: () => 999, forSession: () => 999 },
      now: () => 0,
      hasProfile: () => false,
      ...over,
    });
    const req = (url: string, headers: Record<string, string>, remoteAddress = "203.0.113.1") => ({ url, headers, socket: { remoteAddress } as never });
    const verdict = (decision: ReturnType<typeof decideUpgrade>) => (decision.ok ? 101 : `${decision.step}:${decision.status}`);
    const asked: string[] = [];
    const principalId = (identity.authenticate(readSessionCookie(cookie), 0) as { principalId: string }).principalId;
    // Authenticated, no profile: past 5b (the gate was asked about THIS principal) to the caps, which are full here.
    const capped = decideUpgrade(req("/gs", { origin: PROD_ORIGIN, cookie }), gate({ hasProfile: (id) => (asked.push(id), false) }));
    assert.equal(verdict(capped), "principal-cap:429");
    assert.deepEqual(asked, [principalId]);
    // Under the caps it opens: the frame gate (gameServer.ts) decides what it may then read.
    assert.equal(verdict(decideUpgrade(req("/gs", { origin: PROD_ORIGIN, cookie }), gate({ counts: { global: () => 0, forIp: () => 0, forAggregate: () => 0, forPrincipal: () => 0, forSession: () => 0 } }))), 101);
    // The earlier steps still answer first: no cookie is 401, a wrong Origin 403 at "origin" -- the gate is not asked.
    assert.equal(verdict(decideUpgrade(req("/gs", { origin: PROD_ORIGIN }), gate())), "authenticate:401");
    assert.equal(verdict(decideUpgrade(req("/gs", { origin: "https://evil.example", cookie }), gate())), "origin:403");
    // With a profile, the caps answer (here: full).
    assert.equal(verdict(decideUpgrade(req("/gs", { origin: PROD_ORIGIN, cookie }), gate({ hasProfile: () => true }))), "principal-cap:429");
    // Development: the dev claim authenticates, and the same gate still refuses a principal it says has no profile.
    const dev = devIdentity();
    const devGate = gate({
      mode: "development",
      allowedOrigins: new Set([DEV_ORIGIN]),
      allowedOriginList: [DEV_ORIGIN],
      devAuthenticator: dev.devAuthenticator ?? null,
      counts: { global: () => 0, forIp: () => 0, forAggregate: () => 0, forPrincipal: () => 0, forSession: () => 0 },
    });
    const devReq = req("/?dev_claim=p-alice", { origin: DEV_ORIGIN, host: "127.0.0.1:8917" }, "127.0.0.1");
    assert.equal(verdict(decideUpgrade(devReq, devGate)), 101, "a public socket in development too");
    assert.equal(verdict(decideUpgrade(devReq, { ...devGate, hasProfile: (id) => id === "pr_dev_p-alice" })), 101);
  });

  test("development principals have a synthetic profile in development only; production never treats pr_dev_ as profiled", async () => {
    // Development: a claim plays, and its seat is named for the claim (the synthetic profile's name).
    const dev = await startServer({});
    try {
      const alice = await Client.open(dev.port, ALICE);
      const created = await alice.op(CREATE());
      assert.equal(created.ok, true, JSON.stringify(created));
      alice.roomHello((created.data as { gameId: string }).gameId);
      await alice.next((frame) => frame.kind === "room", "Alice's view");
      assert.equal(viewIn(alice, (created.data as { gameId: string }).gameId)?.players[0].nickname, ALICE, "an empty create nickname is the profile's name");
      assert.equal(dev.server.identity.sizes().profiles, 0, "never stored");
    } finally {
      await stopServer(dev.server);
    }
    // Production: no cookie maps to a pr_dev_ principal, and the claim on the URL is ignored.
    const { server, port } = await prodServer();
    try {
      assert.equal(server.identity.isProfiled("pr_dev_p-alice"), false);
      const socket = new WebSocket(`ws://127.0.0.1:${port}/gs?dev_claim=p-alice`, { origin: PROD_ORIGIN });
      const status = await new Promise<number>((resolve) => {
        socket.on("error", () => undefined);
        socket.once("open", () => resolve(101));
        socket.once("unexpected-response", (req, res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          req.destroy();
        });
      });
      assert.equal(status, 401);
    } finally {
      await stopServer(server);
    }
  });

  test("defence in depth (P3-ACCT allow-list): a socket whose principal has no profile has every frame but the public reads answered `profile-required`, before any game is read", async () => {
    const records = createMemoryRecordStore();
    const { server, port } = await prodServer({ records });
    try {
      const ann = await profiledBrowser(port, "Ann");
      const { gameId } = await tableOf(port, ann.cookie, "ann-table");
      const client = await Client.openWithCookie(port, ann.cookie, "ann");
      const identity = server.identity as unknown as { isProfiled: (principalId: string) => boolean };
      identity.isProfiled = () => false; // a profile is never taken away; this simulates the impossible case
      try {
        const create = await client.op(CREATE());
        assert.deepEqual([create.ok, create.code], [false, "profile-required"]);
        const myTables = await client.op({ type: "my-tables" });
        assert.deepEqual([myTables.ok, myTables.code], [false, "profile-required"], "Your tables is identity-bearing");
        const seat = await client.op({ type: "take-seat" }, gameId);
        assert.deepEqual([seat.ok, seat.code], [false, "profile-required"]);
        client.send({ kind: "chat-send", gameId, text: "hi" });
        client.submit(BUY, { baseIndex: 0, submissionId: "gate-submit" });
        client.send({ kind: "presence-set", gameId, state: { actingCompanyId: null } });
        const refusedSubmit = await client.answerTo("gate-submit");
        assert.deepEqual([refusedSubmit.kind, refusedSubmit.code], ["refused", "profile-required"]);
        await until(() => client.of("error").filter((frame) => frame.code === "profile-required").length === 1, "the chat refused");
        await sleep(50);
        assert.equal(client.of("error").length, 1, "presence is dropped silently; nothing else answered");
        assert.equal(records.records.size, 1, "nothing created");
        // The PUBLIC READS are answered (a public table: read as any watcher reads it -- Watch is read-only).
        client.send({ kind: "rooms-watch", on: true });
        await client.next((frame) => frame.kind === "rooms", "the public list");
        client.roomHello(gameId);
        await client.next((frame) => frame.kind === "room", "the public table's view");
      } finally {
        delete (identity as { isProfiled?: unknown }).isProfiled;
      }
      // And with the profile back, the same socket reads its table.
      client.roomHello(gameId);
      await client.next((frame) => frame.kind === "room", "the view");
      await client.close();
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    RECOVERY ("Forgot password?" by the Authorization Wallet; PHASE 3 FINAL -- the LIVE-2E recovery key is retired)
   ================================================================== */

describe("LIVE-2E recovery (PHASE 3 FINAL: by the Authorization Wallet)", () => {
  test("the right wallet: 200 + a cookie for the SAME principal, whose sockets see the same seat; the browser's temporary cookie ends; EVERY earlier session of the account ends", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await profiledBrowser(port, "Ann");
      const annPrincipal = principalOf(server, ann.cookie);
      const table = await tableOf(port, ann.cookie, "ann-table");
      const annSocket = await Client.openWithCookie(port, ann.cookie, "ann");
      const before = await bootstrapCookie(port);
      assert.equal(((await session(port, before)).body as { profile: unknown }).profile, null, "unprofiled before (P3-ACCT: its socket would be a public one)");
      // The username as typed: surrounding spaces and another case are forgiven (its canonical key decides).
      const answer = await recover(port, before, { username: `  ${ann.username.toUpperCase()}\n`, wallet: ann.wallet });
      assert.equal(answer.status, 200, answer.text);
      assert.deepEqual(answer.body, { ok: true, profile: { name: "Ann" }, signedOut: 1 });
      assert.ok(!/pr_|pf_|se_|rk_/.test(answer.text), "no id in the answer");
      assert.equal(answer.headers["cache-control"], "no-store");
      const recovered = cookieFromAnswer(answer) as string;
      assert.match((answer.headers["set-cookie"] ?? [])[0], /; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=15552000$/);
      assert.notEqual(recovered, before);
      assert.equal(principalOf(server, recovered), annPrincipal, "the SAME principal");
      // The same seat: the table the profile created, seen from the recovered browser.
      const view = await viewWith(port, recovered, table.gameId, "recovered");
      assert.deepEqual([view.you.role, view.you.playerId], ["host", table.playerId]);
      // The browser's temporary session is replaced: it bootstraps to session-ended, and upgrades nothing.
      const replaced = await session(port, before);
      assert.deepEqual([replaced.status, replaced.body], [401, { error: "session-ended", reason: "replaced" }]);
      assert.equal(await upgradeStatus(port, before), 401);
      assert.equal(server.identity.peekSession(sessionIdOfCookie(before))?.revoke_reason, "replaced");
      /* PHASE 3 FINAL (owner ruling): "Forgot password?" revokes EVERY session of the account -- a cookie stolen with the
         password does not outlive the recovery (LIVE-2E's key recovery left other devices signed in). */
      assert.equal(await annSocket.closed, 4401, "the other device's socket is closed");
      assert.deepEqual((await session(port, ann.cookie)).body, { error: "session-ended", reason: "signed-out-remotely" });
      assert.equal(await upgradeStatus(port, ann.cookie), 401);
      assert.deepEqual(((await session(port, recovered)).body as { profile: unknown }).profile, profileOf(ann, 0));
      // The new password signs in; the old one no longer does.
      assert.equal((await loginOnFreshBrowser(port, ann.username, NEW_PASSWORD)).answer.status, 200);
      assert.equal((await loginOnFreshBrowser(port, ann.username, ann.password)).answer.status, 403);
      // Already-profiled browsers cannot recover (the RECOVER text is not minted), and nothing about them changes.
      const again = await recover(port, recovered, { username: ann.username, wallet: ann.wallet });
      assert.deepEqual([again.status, again.body], [409, { error: "already-profiled" }]);
      const bea = await profiledBrowser(port, "Bea");
      const beaPrincipal = principalOf(server, bea.cookie);
      assert.equal((await recover(port, bea.cookie, { username: ann.username, wallet: ann.wallet })).status, 409, "a signed-in browser of another profile is refused too");
      assert.equal(principalOf(server, bea.cookie), beaPrincipal);
      assert.equal(((await session(port, bea.cookie)).body as { profile: { name: string } }).profile.name, "Bea", "Bea's browser is still Bea's");
      assert.equal(server.identity.stats.accountRecoveries, 1);
    } finally {
      await stopServer(server);
    }
  });

  test("one answer for every wrong proof: another wallet, another key's signature, an unknown or another account's username, a malformed signature, an unknown operation, a REPLACED wallet -- none replaces the browser's session", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await profiledBrowser(port, "Ann");
      const annPrincipal = principalOf(server, ann.cookie);
      const bea = await profiledBrowser(port, "Bea");
      const mallory = keplrAccount("live2e/recover/mallory");
      const wrong: Array<[string, (cookie: string) => Promise<ApiAnswer>]> = [
        ["a wallet that is not the account's (its own valid signature)", (cookie) => recover(port, cookie, { username: ann.username, wallet: mallory })],
        ["the account's wallet named, another key signing", (cookie) => recover(port, cookie, { username: ann.username, wallet: ann.wallet, signer: mallory })],
        ["an unknown username", (cookie) => recover(port, cookie, { username: "nobody-at-all", wallet: ann.wallet })],
        ["another account's username", (cookie) => recover(port, cookie, { username: bea.username, wallet: ann.wallet })],
        ["a malformed signature", (cookie) => recover(port, cookie, { username: ann.username, wallet: ann.wallet, forge: () => ({ pubKey: "not a key", signature: "not a signature" }) })],
        ["an empty signature", (cookie) => recover(port, cookie, { username: ann.username, wallet: ann.wallet, forge: () => ({ pubKey: "", signature: "" }) })],
        ["an unknown operation", (cookie) => post(port, "/gs/api/account/recover", cookie, { operation: "0".repeat(32), ...ann.wallet.sign("anything at all"), newPassword: NEW_PASSWORD })],
      ];
      const observed = new Set<string>();
      for (const [what, attempt] of wrong) {
        const before = await bootstrapCookie(port);
        const answer = await attempt(before);
        assert.deepEqual([answer.status, answer.body], [403, { error: "invalid-credential" }], what);
        assert.equal(answer.headers["set-cookie"], undefined, what);
        observed.add(observable(answer));
        const still = await session(port, before);
        assert.deepEqual([still.status, (still.body as { profile: unknown }).profile], [200, null], `${what}: the browser keeps its own session`);
      }
      assert.equal(observed.size, 1, "status, headers and body are identical for every wrong proof");

      // The Authorization Wallet replaced ("Confirm it's you", then BOTH wallets sign): the old wallet stops at once and
      // answers exactly like any wrong proof; the new one recovers.
      const next = keplrAccount("live2e/recover/ann-next");
      const replaced = await replaceAuthorizationWallet(port, ann, ann.wallet, next);
      assert.equal(replaced.status, 200, replaced.text);
      assert.equal((replaced.body as { authorizationWallet: { address: string } }).authorizationWallet.address, next.address);
      const old = await recoverOnFreshBrowser(port, { username: ann.username, wallet: ann.wallet });
      assert.equal(old.answer.status, 403);
      observed.add(observable(old.answer));
      assert.equal(observed.size, 1, "a replaced wallet is indistinguishable from a wrong one");
      const works = await recoverOnFreshBrowser(port, { username: ann.username, wallet: next });
      assert.equal(works.answer.status, 200, works.answer.text);
      assert.equal(principalOf(server, works.cookie as string), annPrincipal);
      assert.equal(server.identity.stats.accountRecoveries, 1);
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    LINK CODES -- RETIRED (PHASE 3 FINAL: a second device signs in with the username and password)
   ================================================================== */

describe("LIVE-2E link codes and the recovery key (retired)", () => {
  /* The three LIVE-2E link-code tests (single use, expiry, one outstanding code) and the recovery-key routes are gone with
     the product: "Link another device" and the recovery key are retired; a second device LOGS IN (P3-ACCT). */
  test("every LIVE-2E credential route answers 410 retired -- nothing issued, read or signed in; a second device logs in instead: the SAME principal", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await profiledBrowser(port, "Ann");
      const fresh = await bootstrapCookie(port);
      const routes: Array<[string, object]> = [
        ["/gs/api/profile", { name: "Somebody" }],
        ["/gs/api/profile/recover", { recoveryKey: `${mintRecoverySelector()}.${mintSecret()}` }],
        ["/gs/api/profile/link", { code: "ABCD-EFGH-JKMN-PQRS-TVWX" }],
        ["/gs/api/profile/link-code", {}],
        ["/gs/api/profile/recovery-key", {}],
        ["/gs/api/profile/key-received", {}],
      ];
      for (const [pathname, body] of routes) {
        for (const cookie of [ann.cookie, fresh, undefined]) {
          const answer = await post(port, pathname, cookie, body);
          assert.deepEqual([answer.status, answer.body], [410, { error: "retired" }], `${pathname} (${cookie === undefined ? "no cookie" : cookie === fresh ? "visitor" : "signed in"})`);
          assert.equal(answer.headers["set-cookie"], undefined);
          assert.equal(answer.headers["cache-control"], "no-store");
        }
      }
      assert.equal(server.identity.sizes().links, 0, "no code is ever issued");
      assert.equal(server.identity.sizes().profiles, 1, "nothing created");
      assert.equal(((await session(port, fresh)).body as { profile: unknown }).profile, null, "the visitor is not signed in");
      assert.deepEqual(((await session(port, ann.cookie)).body as { profile: unknown }).profile, profileOf(ann, 0));
      // A second device: the username and password.
      const phone = await loginOnFreshBrowser(port, ann.username, ann.password);
      assert.equal(phone.answer.status, 200, phone.answer.text);
      assert.deepEqual(phone.answer.body, { ok: true, profile: { name: "Ann" } });
      assert.equal(principalOf(server, phone.cookie as string), principalOf(server, ann.cookie), "the profile's own principal");
      assert.deepEqual((await session(port, phone.before)).body, { error: "session-ended", reason: "replaced" });
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    SIGNING OUT
   ================================================================== */

describe("LIVE-2E sign out", () => {
  test("sign out this device: its sockets close 4401, its cookie is 401 logout -- also after a restart -- and the other device plays on", async () => {
    const dir = tmpDir("logout");
    try {
      let { server, port } = await fileServer(dir);
      const ann = await profiledBrowser(port, "Ann");
      const table = await tableOf(port, ann.cookie, "ann-table");
      const phone = (await loginOnFreshBrowser(port, ann.username, ann.password)).cookie as string;
      const laptopSockets = [await Client.openWithCookie(port, ann.cookie, "laptop-1"), await Client.openWithCookie(port, ann.cookie, "laptop-2")];
      const phoneSocket = await Client.openWithCookie(port, phone, "phone");
      const out = await signOut(port, ann.cookie);
      assert.equal(out.status, 204);
      assert.match((out.headers["set-cookie"] ?? [])[0], /^__Host-gs_session=; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=0$/);
      for (const socket of laptopSockets) assert.equal(await socket.closed, 4401);
      await sleep(30);
      assert.ok(phoneSocket.open, "the other device's socket stays open");
      assert.deepEqual((await session(port, ann.cookie)).body, { error: "session-ended", reason: "logout" });
      assert.equal(await upgradeStatus(port, ann.cookie), 401);
      assert.deepEqual((await post(port, "/gs/api/account/me", ann.cookie)).body, { error: "not-authenticated" });
      assert.deepEqual(((await session(port, phone)).body as { profile: unknown }).profile, profileOf(ann, 0));
      assert.deepEqual((await viewWith(port, phone, table.gameId, "phone")).you.playerId, table.playerId, "the seat stays the profile's");
      await phoneSocket.close();
      await stopServer(server);

      ({ server, port } = await fileServer(dir));
      try {
        assert.deepEqual((await session(port, ann.cookie)).body, { error: "session-ended", reason: "logout" }, "no resurrection at a restart");
        assert.equal(await upgradeStatus(port, ann.cookie), 401);
        assert.equal((await session(port, phone)).status, 200);
        assert.equal((await viewWith(port, phone, table.gameId, "phone-again")).you.playerId, table.playerId);
      } finally {
        await stopServer(server);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sign out other devices: every other session ends signed-out-remotely and its sockets close 4401; this one stays, with the seats", async () => {
    const dir = tmpDir("others");
    const clock = { now: Date.now() };
    try {
      let { server, port } = await fileServer(dir, clock);
      const ann = await profiledBrowser(port, "Ann");
      const table = await tableOf(port, ann.cookie, "ann-table");
      const phone = (await loginOnFreshBrowser(port, ann.username, ann.password)).cookie as string;
      const tablet = (await loginOnFreshBrowser(port, ann.username, ann.password)).cookie as string;
      const sockets = {
        laptop: await Client.openWithCookie(port, ann.cookie, "laptop"),
        phone: await Client.openWithCookie(port, phone, "phone"),
        tablet: await Client.openWithCookie(port, tablet, "tablet"),
      };
      assert.deepEqual(((await session(port, tablet)).body as { profile: unknown }).profile, profileOf(ann, 2));
      /* ESCROW-3A: once the sign-in's own few minutes are over, the tablet's live session alone is not enough -- 403
         reauth-required, nobody signed out. */
      clock.now += 6 * 60_000;
      assert.deepEqual((await signOutOthers(port, tablet)).body, { error: "reauth-required" });
      assert.deepEqual(((await session(port, tablet)).body as { profile: unknown }).profile, profileOf(ann, 2));
      const done = await signOutOthers(port, tablet, ann.password);
      assert.deepEqual([done.status, done.body], [200, { ok: true, signedOut: 2 }]);
      assert.equal(await sockets.laptop.closed, 4401);
      assert.equal(await sockets.phone.closed, 4401);
      await sleep(30);
      assert.ok(sockets.tablet.open);
      for (const ended of [ann.cookie, phone]) {
        assert.deepEqual((await session(port, ended)).body, { error: "session-ended", reason: "signed-out-remotely" });
        assert.equal(await upgradeStatus(port, ended), 401);
      }
      assert.deepEqual(((await session(port, tablet)).body as { profile: unknown }).profile, profileOf(ann, 0));
      assert.equal((await viewWith(port, tablet, table.gameId, "tablet")).you.playerId, table.playerId, "nothing about the seats changed");
      assert.deepEqual((await signOutOthers(port, tablet)).body, { ok: true, signedOut: 0 }, "idempotent");
      await sockets.tablet.close();
      await stopServer(server);

      ({ server, port } = await fileServer(dir, clock));
      try {
        for (const ended of [ann.cookie, phone]) assert.deepEqual((await session(port, ended)).body, { error: "session-ended", reason: "signed-out-remotely" });
        assert.equal((await session(port, tablet)).status, 200);
      } finally {
        await stopServer(server);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ==================================================================
    PERSISTENCE AND CRASHES
   ================================================================== */

describe("LIVE-2E persistence", () => {
  test("a restart over the file store keeps the account (its Authorization Wallet; no recovery key), a replaced password's invalidity and the revocations -- and no plaintext", async () => {
    const dir = tmpDir("restart");
    try {
      let { server, port } = await fileServer(dir);
      const ann = await profiledBrowser(port, "Ann");
      const table = await tableOf(port, ann.cookie, "ann-table");
      const phone = await loginOnFreshBrowser(port, ann.username, ann.password);
      assert.equal(phone.answer.status, 200);
      assert.equal((await signOut(port, phone.cookie as string)).status, 204);
      const changed = await changePassword(port, ann.cookie, ann.password, NEW_PASSWORD);
      assert.equal(changed.status, 200, changed.text);
      const laptop = cookieFromAnswer(changed) as string;
      const principal = principalOf(server, laptop);
      await stopServer(server);

      const file = readIdentityFile(dir);
      assert.equal(file.version, IDENTITY_FILE_VERSION);
      const profiles = file.profiles as Profile[];
      assert.equal(profiles.length, 1);
      assert.equal(profiles[0].schema, 3);
      assert.equal(profiles[0].wallet_address, ann.wallet.address, "its Authorization Wallet");
      assert.equal(profiles[0].recovery_hash, sealedRecoveryDigest(profiles[0].recovery_selector), "no recovery key: the sealed digest");
      assert.equal((file.links as unknown[]).length, 0, "no link code is ever issued");
      const text = JSON.stringify(file);
      for (const secret of [ann.password, NEW_PASSWORD, ann.cookie.split(".")[2], laptop.split(".")[2], (phone.cookie as string).split(".")[2], phone.before.split(".")[2]]) {
        assert.ok(!text.includes(secret), "no password or cookie secret in identity.json");
      }

      ({ server, port } = await fileServer(dir));
      try {
        assert.deepEqual(((await session(port, laptop)).body as { profile: unknown }).profile, profileOf(ann, 0));
        assert.equal(principalOf(server, laptop), principal);
        assert.deepEqual((await session(port, ann.cookie)).body, { error: "session-ended", reason: "replaced" }, "the changer's old cookie stays replaced");
        assert.deepEqual((await session(port, phone.cookie as string)).body, { error: "session-ended", reason: "logout" });
        assert.equal((await loginOnFreshBrowser(port, ann.username, ann.password)).answer.status, 403, "the replaced password stays dead");
        const viaPassword = await loginOnFreshBrowser(port, ann.username, NEW_PASSWORD);
        assert.equal(viaPassword.answer.status, 200, "the new password survives the restart");
        assert.equal(principalOf(server, viaPassword.cookie as string), principal);
        assert.equal((await viewWith(port, viaPassword.cookie as string, table.gameId, "after-restart")).you.playerId, table.playerId);
        const viaWallet = await recoverOnFreshBrowser(port, { username: ann.username, wallet: ann.wallet, newPassword: "a third passphrase" });
        assert.equal(viaWallet.answer.status, 200, "the Authorization Wallet survives the restart");
        assert.equal(principalOf(server, viaWallet.cookie as string), principal);
        assert.equal((await viewWith(port, viaWallet.cookie as string, table.gameId, "recovered-after-restart")).you.playerId, table.playerId);
      } finally {
        await stopServer(server);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a v1 identity.json migrates: its guest becomes unprofiled with its session and seats, and its first account takes them along", async () => {
    const dir = tmpDir("v1");
    try {
      const now = Date.now();
      const principalId = mintPrincipalId();
      const sessionId = mintSessionId();
      const secret = mintSecret();
      const cookie = `__Host-gs_session=v1.${sessionId}.${secret}`;
      const v1 = {
        format: "gs-identity",
        version: 1,
        principals: [{ principal_id: principalId, kind: "guest", status: "active", created_at: now - 1000, activated_at: now - 1000, last_seen_at: now - 1000, account_link: null }],
        sessions: [
          {
            session_id: sessionId,
            principal_id: principalId,
            secret_hash: secretHash(secret),
            created_at: now - 1000,
            last_seen_at: now - 1000,
            expires_at: now + 30 * DAY,
            revoked_at: null,
            revoke_reason: null,
            rotated_to: null,
          },
        ],
      };
      fs.writeFileSync(path.join(dir, IDENTITY_FILE), JSON.stringify(v1));
      // A LIVE-2D seat this guest already holds.
      const records = createMemoryRecordStore();
      const base = seededRecord([ALICE, BOB]);
      const record = { ...base, created_by_principal: principalId, seats: base.seats.map((seat, at) => (at === 0 ? { ...seat, principal_id: principalId } : seat)) };
      assert.equal((await records.put(record, null)).kind, "committed");

      const service = await IdentityService.open(createFileIdentityStore(dir, { warn: () => undefined }), { policy: POLICY });
      assert.equal(service.peekPrincipal(principalId)?.kind, "unprofiled");
      assert.equal(service.peekPrincipal(principalId)?.account_link, null);
      assert.equal(service.isProfiled(principalId), false);
      assert.equal(readIdentityFile(dir).version, 1, "the load writes nothing");
      const { server, port } = await prodServer({ service, records });
      try {
        const boot = await session(port, cookie);
        assert.deepEqual([boot.status, (boot.body as { profile: unknown }).profile], [200, null], "its session holds; it meets the profile gate");
        assert.equal(await upgradeStatus(port, cookie), 101, "P3-ACCT: a public, read-only socket until it signs in");
        /* LIVE-2E review M2: this browser played before profiles existed, so it may hold seats. Signing it in to
           ANOTHER account would orphan them: login and recovery are refused `has-tables`, and nothing is spent. */
        const other = await profiledBrowser(port, "Other");
        assert.deepEqual([(await login(port, cookie, other.username, other.password)).body, (await recover(port, cookie, { username: other.username, wallet: other.wallet })).body], [
          { error: "has-tables" },
          { error: "has-tables" },
        ]);
        assert.equal((await session(port, cookie)).status, 200, "its session was not replaced");
        assert.equal((await loginOnFreshBrowser(port, other.username, other.password)).answer.status, 200, "the other account is untouched");
        // It creates ITS OWN account: the SAME principal is bound, so its seats come with it.
        const created = await createAccount(port, cookie, { username: "old.guest", name: "Old Guest", wallet: keplrAccount("live2e/v1/old-guest") });
        assert.equal(created.status, 201, created.text);
        const signedIn = cookieFromAnswer(created) as string;
        const file = readIdentityFile(dir);
        assert.equal(file.version, IDENTITY_FILE_VERSION, "a commit writes the current version");
        const stored = (file.principals as Array<{ principal_id: string; kind: string; account_link: string }>).find((p) => p.principal_id === principalId);
        assert.equal(stored?.kind, "profile", "the SAME principal is bound -- so its seats come with it");
        assert.ok((file.profiles as Array<{ principal_id: string }>).some((profile) => profile.principal_id === principalId));
        assert.equal(principalOf(server, signedIn), principalId);
        const view = await viewWith(port, signedIn, record.game_id, "old-guest");
        assert.deepEqual([view.you.role, view.you.playerId], ["host", ALICE], "the seat it held before profiles existed");
      } finally {
        await stopServer(server);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a half-bound profile refuses to load (either side), as does a link code naming no profile; a well-bound LEGACY profile loads retired, an Authorization Wallet account loads profiled", async () => {
    const dir = tmpDir("halfbound");
    try {
      const now = Date.now();
      const principal = (id: string, kind: "unprofiled" | "profile", link: string | null) => ({
        principal_id: id,
        kind,
        status: "active",
        created_at: now,
        activated_at: now,
        last_seen_at: now,
        account_link: link,
      });
      const profile = (id: string, owner: string) => ({
        profile_id: id,
        principal_id: owner,
        display_name: "Ann",
        created_at: now,
        status: "active",
        recovery_selector: mintRecoverySelector(),
        recovery_hash: secretHash(mintSecret()),
        recovery_rotated_at: now,
        schema: 1,
      });
      const doc = (principals: unknown[], profiles: unknown[], links: unknown[] = []) => ({ format: "gs-identity", version: 2, principals, sessions: [], profiles, links });
      const [p1, p2] = [mintPrincipalId(), mintPrincipalId()];
      const [f1, f2] = [mintProfileId(), mintProfileId()];
      const link = (profileId: string) => ({ link_hash: linkCodeHash("A".repeat(20)), profile_id: profileId, created_at: now, expires_at: now + 1, consumed_at: null });
      /* PHASE 3 FINAL: the Authorization Wallet account (schema 3): a username login, its Authorization Wallet, and the
         sealed digest of its own credential epoch. */
      const legacy = profile(f1, p1);
      const account = {
        ...legacy,
        schema: 3,
        recovery_hash: sealedRecoveryDigest(legacy.recovery_selector),
        login_key: "ann",
        login_name: "Ann",
        password_hash: await hashPassword(PASSWORD, TEST_PASSWORD_KDF),
        password_set_at: now,
        wallet_address: keplrAccount("live2e/halfbound").address,
        wallet_verified_at: now,
      };
      const cases: Array<[string, object]> = [
        ["a profile principal naming no stored profile", doc([principal(p1, "profile", f1)], [])],
        ["a profile whose principal is unprofiled", doc([principal(p1, "unprofiled", null)], [profile(f1, p1)])],
        ["a profile naming no stored principal", doc([], [profile(f1, p1)])],
        ["a principal naming another profile than the one naming it", doc([principal(p1, "profile", f2)], [profile(f1, p1), profile(f2, p2)])],
        ["two profiles for one principal", doc([principal(p1, "profile", f1)], [profile(f1, p1), profile(f2, p1)])],
        ["a link code naming no profile", doc([principal(p1, "profile", f1)], [profile(f1, p1)], [link(f2)])],
        ["a v1 principal that is not a guest", { format: "gs-identity", version: 1, principals: [principal(p1, "profile", f1)], sessions: [] }],
        ["a v2 document without its profile collections", { format: "gs-identity", version: 2, principals: [], sessions: [] }],
        ["an account (schema 3) without its Authorization Wallet", doc([principal(p1, "profile", f1)], [{ ...account, wallet_address: null, wallet_verified_at: null }])],
      ];
      for (const [what, bad] of cases) {
        fs.writeFileSync(path.join(dir, IDENTITY_FILE), JSON.stringify(bad));
        await assert.rejects(createFileIdentityStore(dir).load(), (error: Error) => error instanceof IdentityStoreCorruptError, what);
        await assert.rejects(IdentityService.open(createFileIdentityStore(dir)), IdentityStoreCorruptError, what);
      }
      // The well-bound LEGACY pair loads -- and, made before Authorization Wallets, is RETIRED: not profiled, no name.
      fs.writeFileSync(path.join(dir, IDENTITY_FILE), JSON.stringify(doc([principal(p1, "profile", f1)], [legacy], [link(f1)])));
      const loaded = await IdentityService.open(createFileIdentityStore(dir));
      assert.ok(loaded.peekProfileOf(p1) !== undefined, "loaded");
      assert.equal(loaded.isProfiled(p1), false, "a legacy profile is retired");
      assert.equal(loaded.profileName(p1), null);
      // The well-bound ACCOUNT loads, profiled.
      fs.writeFileSync(path.join(dir, IDENTITY_FILE), JSON.stringify(doc([principal(p1, "profile", f1)], [account])));
      const current = await IdentityService.open(createFileIdentityStore(dir));
      assert.equal(current.isProfiled(p1), true);
      assert.equal(current.profileName(p1), "Ann");
      assert.deepEqual(current.authorizationWallet(p1), { address: account.wallet_address, since: now });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an injected store failure on create, login, change password, sign-out-others and recover answers 503 and changes nothing -- each retried works", async () => {
    const { service, store } = memoryService();
    const { server, port } = await prodServer({ service });
    const fail = () => store.failNext.push("definite");
    const durable = () => JSON.stringify(store.snapshot());
    try {
      const ann = await profiledBrowser(port, "Ann");
      // Create.
      const bea = await bootstrapCookie(port);
      const proof = await createAuthorization(port, bea, "bea.fails", keplrAccount("live2e/fail/bea"));
      const createBody = { username: "bea.fails", password: PASSWORD, name: "Bea", ...proof };
      let before = durable();
      fail();
      const refusedCreate = await post(port, "/gs/api/account/create", bea, createBody);
      assert.deepEqual([refusedCreate.status, refusedCreate.body], [503, { error: "unavailable" }]);
      assert.ok(refusedCreate.headers["retry-after"]);
      assert.equal(refusedCreate.headers["set-cookie"], undefined);
      assert.equal(durable(), before);
      assert.equal(((await session(port, bea)).body as { profile: unknown }).profile, null, "no profile half-created");
      assert.equal(await upgradeStatus(port, bea), 101, "P3-ACCT: still only a public, read-only socket");
      assert.equal((await post(port, "/gs/api/account/create", bea, createBody)).status, 201, "the retry creates it -- the same signed CREATE (a transient failure released it)");

      // Log in.
      const phoneBrowser = await bootstrapCookie(port);
      before = durable();
      fail();
      const refusedLogin = await login(port, phoneBrowser, ann.username, ann.password);
      assert.deepEqual([refusedLogin.status, refusedLogin.body], [503, { error: "unavailable" }]);
      assert.equal(refusedLogin.headers["set-cookie"], undefined);
      assert.equal(durable(), before);
      assert.equal(((await session(port, phoneBrowser)).body as { profile: unknown }).profile, null, "the browser's session was not replaced");
      const loggedIn = await login(port, phoneBrowser, ann.username, ann.password);
      assert.equal(loggedIn.status, 200, "the retry signs in");
      const phone = cookieFromAnswer(loggedIn) as string;
      assert.equal(principalOf(server, phone), principalOf(server, ann.cookie));

      // Change password: the old one keeps working after a refused change.
      before = durable();
      fail();
      assert.equal((await changePassword(port, ann.cookie, ann.password, NEW_PASSWORD)).status, 503);
      assert.equal(durable(), before);
      for (const cookie of [ann.cookie, phone]) assert.equal((await session(port, cookie)).status, 200, "nobody was signed out");

      // Sign out other devices: nobody is signed out.
      before = durable();
      fail();
      assert.equal((await reauth(port, ann.cookie, ann.password)).status, 200); // writes nothing: the fault stays armed
      assert.equal((await signOutOthers(port, ann.cookie)).status, 503);
      assert.equal(durable(), before);
      assert.equal((await session(port, phone)).status, 200);
      assert.equal(await upgradeStatus(port, phone), 101);

      // Recover: the same signed RECOVER is accepted on the retry.
      const tablet = await bootstrapCookie(port);
      const minted = await post(port, "/gs/api/account/authorization", tablet, { purpose: "recover", username: ann.username, wallet: ann.wallet.address });
      assert.equal(minted.status, 200);
      const recoverBody = { operation: minted.body?.operation, ...ann.wallet.sign((minted.body?.texts as Array<{ text: string }>)[0].text), newPassword: NEW_PASSWORD };
      before = durable();
      fail();
      assert.equal((await post(port, "/gs/api/account/recover", tablet, recoverBody)).status, 503);
      assert.equal(durable(), before);
      assert.equal(((await session(port, tablet)).body as { profile: unknown }).profile, null);
      assert.equal((await session(port, phone)).status, 200, "nobody was signed out");
      const recovered = await post(port, "/gs/api/account/recover", tablet, recoverBody);
      assert.deepEqual([recovered.status, recovered.body], [200, { ok: true, profile: { name: "Ann" }, signedOut: 2 }]);
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    BUDGETS
   ================================================================== */

describe("LIVE-2E rate limits", () => {
  test("recoveries: the address budget counts FAILURES and never refuses the right Authorization Wallet (ESCROW-3A §10C); apart from every room limit", async () => {
    const { server, port } = await prodServer({
      limits: { credentialRedeemsPerIp: { capacity: 3, refillPerSecond: 0.0001 } },
      rooms: { createsPerIp: { capacity: 1, refillPerSecond: 0.0001 } },
    });
    try {
      const ann = await profiledBrowser(port, "Ann");
      const mallory = keplrAccount("live2e/budget/mallory");
      // The room budget is spent first: it touches no recovery.
      const socket = await Client.openWithCookie(port, ann.cookie, "ann");
      const table = await socket.op(CREATE());
      assert.equal(table.ok, true);
      const { gameId } = table.data as { gameId: string };
      assert.equal((await socket.op(CREATE())).code, "rate-limited");
      // A neighbour on the same address spends the address's FAILURE budget (3) with wrong proofs ...
      assert.equal((await recoverOnFreshBrowser(port, { username: ann.username, wallet: mallory })).answer.status, 403);
      assert.equal((await recoverOnFreshBrowser(port, { username: "nobody-at-all", wallet: mallory })).answer.status, 403);
      assert.equal((await recoverOnFreshBrowser(port, { username: ann.username, wallet: ann.wallet, signer: mallory })).answer.status, 403);
      // ... after which every WRONG proof is 429 -- for a real username and an unknown one alike ...
      const limited = await recoverOnFreshBrowser(port, { username: "nobody-at-all", wallet: mallory });
      assert.equal(limited.answer.status, 429);
      assert.equal((limited.answer.body as { error: string }).error, "rate-limited");
      assert.ok(Number(limited.answer.headers["retry-after"]) >= 1);
      const realUsername = await recoverOnFreshBrowser(port, { username: ann.username, wallet: mallory });
      assert.deepEqual([realUsername.answer.status, realUsername.answer.body], [limited.answer.status, limited.answer.body], "no existence oracle");
      assert.equal(server.identityLimiter.denied["credential-ip"], 2);
      assert.equal((await session(port, limited.before)).status, 200, "a refused recovery replaces nothing");
      // ... and the rooms are untouched by it: the same player's socket still acts ...
      assert.equal((await socket.op({ type: "set-ready", ready: true }, gameId)).ok, true);
      // ... and the RIGHT wallet still recovers: it is never refused on the address budget.
      assert.equal((await recoverOnFreshBrowser(port, { username: ann.username, wallet: ann.wallet })).answer.status, 200, "the right wallet is never refused on the address budget");
      assert.equal(await socket.closed, 4401, "(and the recovery signed the old device out)");
    } finally {
      await stopServer(server);
    }
    /* LIVE-2E review M1: there is NO server-wide recovery budget -- it would let a few addresses switch recovery off for
       everybody. The second budget is the SESSION's: one browser cannot guess on past its own allowance. */
    const perSession = await prodServer({ limits: { credentialRedeemsPerSession: { capacity: 2, refillPerSecond: 0.0001 } } });
    try {
      const mallory = keplrAccount("live2e/budget/mallory");
      const guesser = await bootstrapCookie(perSession.port);
      for (let n = 0; n < 2; n += 1) assert.equal((await recover(perSession.port, guesser, { username: "someone", wallet: mallory })).status, 403);
      const third = await recover(perSession.port, guesser, { username: "someone", wallet: mallory });
      assert.equal(third.status, 429, "the session's budget is spent: not even a RECOVER text is minted");
      assert.equal(perSession.server.identityLimiter.denied["credential-session"], 1);
      // Another browser (same address) is not held back by that session's guessing.
      assert.equal((await recoverOnFreshBrowser(perSession.port, { username: "someone", wallet: mallory })).answer.status, 403);
    } finally {
      await stopServer(perSession.server);
    }
  });

  test("account creations are budgeted per address (the CREATE text is refused before Keplr signs); a refused one creates nothing; profile actions per SESSION", async () => {
    const { service, store } = memoryService();
    const { server, port } = await prodServer({
      service,
      limits: { profileCreatesPerIp: { capacity: 2, refillPerSecond: 0.0001 }, profileActionsPerSession: { capacity: 3, refillPerSecond: 0.0001 } },
    });
    try {
      const ann = await profiledBrowser(port, "Ann");
      await profiledBrowser(port, "Bea");
      const third = await bootstrapCookie(port);
      const limited = await post(port, "/gs/api/account/authorization", third, { purpose: "create", username: "cy.third", wallet: keplrAccount("live2e/budget/cy").address });
      assert.equal(limited.status, 429);
      assert.ok(limited.headers["retry-after"]);
      assert.equal(server.identityLimiter.denied["profile-create-ip"], 1);
      assert.equal(store.snapshot().profiles.length, 2);
      assert.equal(((await session(port, third)).body as { profile: unknown }).profile, null);
      // Profile actions: three (a "Confirm it's you", a sign-out of other devices, another confirmation), then 429 for
      // this SESSION (LIVE-2E review H1) ...
      assert.equal((await reauth(port, ann.cookie, ann.password)).status, 200);
      assert.deepEqual((await signOutOthers(port, ann.cookie)).body, { ok: true, signedOut: 0 });
      assert.equal((await reauth(port, ann.cookie, ann.password)).status, 200);
      assert.equal((await signOutOthers(port, ann.cookie)).status, 429);
      assert.equal(server.identityLimiter.denied["profile-actions"], 1);
      // ... and another device of the same account keeps its own: spending one device's budget cannot stop the owner's
      // other device from signing it out.
      const phone = await loginOnFreshBrowser(port, ann.username, ann.password);
      assert.equal(phone.answer.status, 200);
      assert.deepEqual((await signOutOthers(port, phone.cookie as string)).body, { ok: true, signedOut: 1 });
      assert.deepEqual((await session(port, ann.cookie)).body, { error: "session-ended", reason: "signed-out-remotely" });
    } finally {
      await stopServer(server);
    }
  });

  /* "LIVE-2E review H1: a leaked link code cannot outlive the owner securing the account" is gone with link codes (no code
     is issued any more: the retired routes answer 410, above); securing the account is now "Sign out other devices" (above)
     and "Forgot password?" by the Authorization Wallet, which ends every session (RECOVERY). */
});

/* ==================================================================
    NOTHING SECRET IS PRINTED
   ================================================================== */

describe("LIVE-2E nothing secret reaches a log line", () => {
  test("a whole account lifecycle, with refusals and store failures, prints no password, signature, cookie, digest or credential epoch", async () => {
    const lines: string[] = [];
    const saved = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...args: unknown[]) => lines.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(" "));
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    const { service, store } = memoryService();
    const THIRD_PASSWORD = "the third passphrase";
    const secrets: string[] = [PASSWORD, NEW_PASSWORD, THIRD_PASSWORD, "a wrong passphrase"];
    const keep = (cookie: string | null) => {
      if (cookie) secrets.push(cookie, cookie.split(".")[2]);
    };
    const { server, port } = await prodServer({ service });
    try {
      const wallet = keplrAccount("live2e/secrets/ann");
      const before = await bootstrapCookie(port);
      keep(before);
      const proof = await createAuthorization(port, before, "ann.secret", wallet);
      secrets.push(proof.signature);
      store.failNext.push("definite");
      await post(port, "/gs/api/account/create", before, { username: "ann.secret", password: PASSWORD, name: "Ann", ...proof });
      const created = await post(port, "/gs/api/account/create", before, { username: "ann.secret", password: PASSWORD, name: "Ann", ...proof });
      assert.equal(created.status, 201, created.text);
      const annCookie = cookieFromAnswer(created) as string;
      keep(annCookie);
      const socket = await Client.openWithCookie(port, annCookie, "ann");
      await socket.op(CREATE());
      const phone = await loginOnFreshBrowser(port, "ann.secret", PASSWORD);
      keep(phone.before);
      keep(phone.cookie);
      keep((await loginOnFreshBrowser(port, "ann.secret", "a wrong passphrase")).before); // a wrong password
      keep((await loginOnFreshBrowser(port, "nobody.here", PASSWORD)).before); // an unknown username
      const forged = await recoverOnFreshBrowser(port, { username: "ann.secret", wallet, signer: keplrAccount("live2e/secrets/mallory") }); // another key
      keep(forged.before);
      if (forged.signed) secrets.push(forged.signed.signature);
      store.failNext.push("definite");
      const failed = await recoverOnFreshBrowser(port, { username: "ann.secret", wallet, newPassword: NEW_PASSWORD });
      assert.equal(failed.answer.status, 503);
      keep(failed.before);
      const tablet = await recoverOnFreshBrowser(port, { username: "ann.secret", wallet, newPassword: NEW_PASSWORD });
      assert.equal(tablet.answer.status, 200, tablet.answer.text);
      keep(tablet.before);
      keep(tablet.cookie);
      if (tablet.signed) secrets.push(tablet.signed.signature);
      await socket.closed; // the recovery ended every earlier session
      store.failNext.push("definite");
      await changePassword(port, tablet.cookie as string, NEW_PASSWORD, THIRD_PASSWORD); // this change's write fails
      const changed = await changePassword(port, tablet.cookie as string, NEW_PASSWORD, THIRD_PASSWORD);
      assert.equal(changed.status, 200, changed.text);
      const desk = cookieFromAnswer(changed) as string;
      keep(desk);
      await signOutOthers(port, desk, THIRD_PASSWORD);
      await signOut(port, desk);
      for (const profile of store.snapshot().profiles) secrets.push(profile.recovery_hash, profile.recovery_selector, profile.password_hash as string);
      for (const record of store.snapshot().sessions) secrets.push(record.secret_hash);
    } finally {
      console.log = saved.log;
      console.warn = saved.warn;
      console.error = saved.error;
      await stopServer(server);
    }
    assert.ok(lines.length > 0, "the server did print (the store failures, at least)");
    const printed = lines.join("\n");
    for (const secret of secrets) assert.ok(!printed.includes(secret), "a secret reached the window");
    assert.ok(!/rk_[0-9a-z]{26}/.test(printed), "no credential epoch (selector) either");
    assert.ok(!/scrypt\$/.test(printed), "no password hash either");
  });
});

/* ==================================================================
    SEAT CONTINUITY (the brief's ten steps)
   ================================================================== */

describe("LIVE-2E seat continuity across devices, a sign-out, a restart and a recovery", () => {
  test("one seat, one principal: a second device signed in, sign-out, restart, recovery -- the same player_id and log, and nothing copied or moved", async () => {
    const dir = tmpDir("continuity");
    const boot = async () => {
      const service = await IdentityService.open(createFileIdentityStore(dir, { warn: () => undefined }), { policy: POLICY });
      return startServer({
        identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, service },
        store: await settledLogStore(dir),
        records: createFileRecordStore(dir),
      });
    };
    const buy = async (client: Client, baseIndex: number, submissionId: string) => {
      client.submit(BUY, { baseIndex, submissionId });
      const answer = await client.answerTo(submissionId);
      assert.equal(answer.kind, "applied", `${submissionId}: ${JSON.stringify(answer)}`);
      return answer.entries as ServerLogEntry[];
    };
    const catchUp = async (client: Client, gameId: string): Promise<ServerLogEntry[]> => {
      client.hello(gameId);
      const frame = await client.next((f) => f.kind === "catch-up", `${client.claim}'s catch-up`);
      return frame.entries as ServerLogEntry[];
    };
    const idsOf = (entries: readonly ServerLogEntry[]) => entries.map((entry) => `${entry.index}:${entry.id}:${entry.actor}`);
    const uniqueByIndex = (entries: readonly ServerLogEntry[]) =>
      entries.filter((entry, at, all) => all.findIndex((other) => other.index === entry.index) === at).sort((a, b) => a.index - b.index);
    try {
      let { server, port } = await boot();

      // 1. Profile A.
      const ann = await profiledBrowser(port, "Ann");
      const annPrincipal = principalOf(server, ann.cookie) as string;

      // 2. A creates a room (an empty nickname: the profile's name); profile B joins (seeded with B's name).
      const laptop = await Client.openWithCookie(port, ann.cookie, "ann-laptop");
      const created = await laptop.op(CREATE());
      assert.equal(created.ok, true, JSON.stringify(created));
      const { gameId, code, playerId: annSeat } = created.data as { gameId: string; code: string; playerId: string };
      const bea = await profiledBrowser(port, "Bea");
      const beaTab = await Client.openWithCookie(port, bea.cookie, "bea");
      const joined = await beaTab.op({ type: "join", code, takeSeat: true });
      assert.equal(joined.ok, true, JSON.stringify(joined));
      const beaSeat = (joined.data as { playerId: string }).playerId;
      for (const client of [laptop, beaTab]) assert.equal((await client.op({ type: "set-ready", ready: true }, gameId)).ok, true);
      assert.equal((await laptop.op({ type: "start-game" }, gameId)).ok, true, "the server deals (host first)");
      laptop.roomHello(gameId);
      await laptop.next((f) => f.kind === "room", "Ann's view");
      assert.deepEqual(viewIn(laptop, gameId)?.players.map((p) => [p.id, p.nickname]), [
        [annSeat, "Ann"],
        [beaSeat, "Bea"],
      ]);

      // 3. They play: A buys, B buys.
      await catchUp(laptop, gameId);
      await catchUp(beaTab, gameId);
      await buy(laptop, 0, "ann-1");
      await buy(beaTab, 1, "bea-1");

      // 4. A signs in on a second device (the username and password -- PHASE 3 FINAL: no link code).
      const phoneCookie = (await loginOnFreshBrowser(port, ann.username, ann.password)).cookie as string;
      assert.equal(principalOf(server, phoneCookie), annPrincipal);

      // 5. The second device sees the same seat, player_id and log.
      const phone = await Client.openWithCookie(port, phoneCookie, "ann-phone");
      phone.roomHello(gameId);
      await phone.next((f) => f.kind === "room", "the phone's view");
      assert.equal(viewIn(phone, gameId)?.you.role, "host");
      assert.equal(viewIn(phone, gameId)?.you.playerId, annSeat, "the same player_id");
      const phoneLog = await catchUp(phone, gameId);
      assert.equal(phoneLog.length, 3, "the deal and two buys");
      assert.deepEqual(idsOf(phoneLog), idsOf(uniqueByIndex(laptop.seen() as unknown as ServerLogEntry[])), "the log the first device holds");

      // 6. The first device still works: it speaks as the seat, and a new socket of it reads the seat.
      laptop.send({ kind: "chat-send", gameId, text: "from the laptop" });
      await until(() => phone.of("chat").some((frame) => (frame.messages as Array<{ author: string; text: string }>).some((line) => line.text === "from the laptop" && line.author === annSeat)), "the laptop's line, as Ann's seat, at the phone");
      const laptopTab2 = await Client.openWithCookie(port, ann.cookie, "ann-laptop-2");
      laptopTab2.roomHello(gameId);
      await laptopTab2.next((f) => f.kind === "room", "the laptop's second tab");
      assert.equal(viewIn(laptopTab2, gameId)?.you.playerId, annSeat);

      // 7. Sign out the first device: its sockets close 4401.
      assert.equal((await signOut(port, ann.cookie)).status, 204);
      assert.equal(await laptop.closed, 4401);
      assert.equal(await laptopTab2.closed, 4401);

      // 8. The second device still owns the seat and moves (the seat is on turn), and play goes on.
      await sleep(30);
      assert.ok(phone.open);
      const moved = await buy(phone, 2, "phone-1");
      assert.equal(moved.find((entry) => entry.index === 3)?.actor, annSeat, "the phone's move is the seat's");
      await buy(beaTab, 3, "bea-2");
      await until(() => phone.seen().some((entry) => entry.index === 4), "Bea's move at the phone");
      const phoneSaw = uniqueByIndex(phone.seen() as unknown as ServerLogEntry[]);
      assert.equal(phoneSaw.length, 5);
      const beforeRestart = await createFileRecordStore(dir).load(gameId);
      await Promise.all([phone.close(), beaTab.close()]);
      await stopServer(server);

      // 9. Restart over the same directory; A recovers on a fresh browser with the Authorization Wallet.
      ({ server, port } = await boot());
      assert.deepEqual((await session(port, ann.cookie)).body, { error: "session-ended", reason: "logout" }, "the signed-out laptop stays out");
      const recovered = await recoverOnFreshBrowser(port, { username: ann.username, wallet: ann.wallet });
      assert.equal(recovered.answer.status, 200, recovered.answer.text);
      const desktopCookie = recovered.cookie as string;
      assert.equal(principalOf(server, desktopCookie), annPrincipal, "the same principal after the restart");

      // 10. The same seat, player_id and log -- and it can move.
      const desktop = await Client.openWithCookie(port, desktopCookie, "ann-desktop");
      desktop.roomHello(gameId);
      await desktop.next((f) => f.kind === "room", "the desktop's view");
      assert.equal(viewIn(desktop, gameId)?.you.role, "host");
      assert.equal(viewIn(desktop, gameId)?.you.playerId, annSeat);
      const desktopLog = await catchUp(desktop, gameId);
      assert.deepEqual(idsOf(desktopLog), idsOf(phoneSaw), "the same log, entry for entry, across the restart");
      const last = await buy(desktop, 4, "desktop-1");
      assert.equal(last.find((entry) => entry.index === 5)?.actor, annSeat, "the recovered browser moves as the seat");
      const beaAgain = await Client.openWithCookie(port, bea.cookie, "bea-again");
      await catchUp(beaAgain, gameId);
      await buy(beaAgain, 5, "bea-3");
      await Promise.all([desktop.close(), beaAgain.close()]);
      await stopServer(server);

      // The durable truth: the log is the deal and gameplay only -- no seat copy, transfer or rebinding entry -- and
      // the record's seats are exactly as they were bound.
      const log = await (await settledLogStore(dir)).loadLog(gameId);
      const kinds = log.map((entry) => Object.keys(JSON.parse(entry.payload))[0]);
      assert.deepEqual(kinds, ["SetupGame", ...Array(6).fill("WaterfallBuyLowest")]);
      assert.deepEqual(log.slice(1).map((entry) => entry.actor), [annSeat, beaSeat, annSeat, beaSeat, annSeat, beaSeat], "laptop, Bea, phone, Bea, recovered desktop, Bea");
      const setup = JSON.parse(log[0].payload).SetupGame as { players: Array<{ id: string }> };
      assert.deepEqual(setup.players.map((player) => player.id), [annSeat, beaSeat]);
      const after = await createFileRecordStore(dir).load(gameId);
      assert.ok(beforeRestart && after);
      assert.deepEqual(after?.seats.map((seat) => [seat.player_id, seat.principal_id, seat.binding_epoch]), beforeRestart?.seats.map((seat) => [seat.player_id, seat.principal_id, seat.binding_epoch]));
      assert.equal(after?.seats.find((seat) => seat.player_id === annSeat)?.principal_id, annPrincipal, "the seat names the same principal throughout");
      assert.equal(after?.host_player_id, annSeat);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
