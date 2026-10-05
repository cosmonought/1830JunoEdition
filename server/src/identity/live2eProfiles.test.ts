// server/src/identity/live2eProfiles.test.ts
//
// ==================================================================
//  LIVE-2E: MANDATORY PROFILES, AGAINST THE REAL SERVER
// ==================================================================
//
// A PROFILE (application identity, mandatory to play) controls exactly one durable PRINCIPAL, which any number of
// SESSIONS (devices) authenticate, and which owns GameRecord seats. These suites drive `createGameServer` in production
// mode over real HTTP and real WebSockets, with real cookies and an allowed Origin, as a browser does:
//   - creation: the cleaned name, the recovery key (shown once, stored only as a digest), no id on the wire, and one
//     profile per principal however many tabs press "Create" at once;
//   - the unprofiled principal: bootstrap `profile: null`, the profiled actions 403 `profile-required`, and -- P3-ACCT
//     (owner, 2026-10-05: public first) -- a PUBLIC, READ-ONLY socket (no longer an upgrade 403): the per-frame
//     allow-list answers only the public reads and refuses everything else `profile-required`;
//   - recovery and device linking: a fresh session for the SAME principal (so the same seats), the browser's temporary
//     session `replaced`, one indistinguishable answer for every wrong credential, single-use and expiring codes;
//   - rotation, "sign out this device", "sign out other devices" -- and their sockets closing 4401;
//   - persistence: a restart over the file store keeps all of it; a v1 file migrates; a half-bound profile refuses to
//     load; an injected store failure changes nothing;
//   - the redemption and creation budgets; nothing secret printed;
//   - SEAT CONTINUITY: one seat across two devices, a sign-out, a restart and a recovery -- nothing copied or moved.

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
  cookieRead,
  devIdentity,
  profiledBrowser,
  quietConsole,
  seededRecord,
  sessionIdOfCookie,
  sleep,
  startServer,
  stopServer,
  until,
  type ApiAnswer,
} from "../rooms/testSupport";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { decideUpgrade, type UpgradeGate } from "./authenticateUpgrade";
import { readSessionCookie } from "./cookies";
import { createFileIdentityStore, IDENTITY_FILE, IDENTITY_FILE_VERSION } from "./fileStore";
import {
  canonicalLinkCode,
  linkCodeHash,
  mintPrincipalId,
  mintProfileId,
  mintRecoverySelector,
  mintSecret,
  mintSessionId,
  RECOVERY_KEY_PATTERN,
  secretHash,
} from "./ids";
import { IdentityLimiter } from "./limiter";
import { IdentityService } from "./sessions";
import { createMemoryIdentityStore, IdentityStoreCorruptError, type MemoryIdentityStore } from "./store";

quietConsole();

const DAY = 24 * 60 * 60 * 1000;
const LINK_CODE_DISPLAY = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/;

/* ==================================================================
    FIXTURES
   ================================================================== */

interface Clock {
  now: number;
}

/** A production server: cookies, `/gs`, the allowed Origin, and a clock the test may step. Every identity budget is
 *  wide (testSupport's roomy limits) unless `limits` narrows one. */
async function prodServer(
  over: { clock?: Clock; service?: IdentityService; limits?: Partial<IdentityLimits>; rooms?: Partial<RoomLimits>; records?: RecordStore; store?: LogStore } = {},
) {
  const clock = over.clock ?? { now: Date.now() };
  const started = await startServer({
    identity: { mode: "production", allowedOrigins: [PROD_ORIGIN], trustedProxyHops: 0, now: () => clock.now, ...(over.service ? { service: over.service } : {}) },
    ...(over.records ? { records: over.records } : {}),
    ...(over.store ? { store: over.store } : {}),
    limits: { identity: { ...(over.limits ?? {}) }, rooms: { ...(over.rooms ?? {}) } },
  });
  return { ...started, clock };
}

/** An in-memory identity service whose store the test can read and fail. */
function memoryService(): { service: IdentityService; store: MemoryIdentityStore } {
  const store = createMemoryIdentityStore();
  return { store, service: IdentityService.fromSnapshot(store, { principals: [], sessions: [] }) };
}

const post = (port: number, pathname: string, cookie?: string, body: object = {}) => apiRequest(port, pathname, { cookie, body });
const session = (port: number, cookie?: string, body: object = {}) => post(port, "/gs/api/session", cookie, body);
const createProfile = (port: number, cookie: string | undefined, name: unknown) => post(port, "/gs/api/profile", cookie, { name });
const recover = (port: number, cookie: string | undefined, recoveryKey: string) => post(port, "/gs/api/profile/recover", cookie, { recoveryKey });
const redeem = (port: number, cookie: string | undefined, code: string) => post(port, "/gs/api/profile/link", cookie, { code });
const linkCode = (port: number, cookie: string) => post(port, "/gs/api/profile/link-code", cookie);
/* ESCROW-3A (brief §10B): rotating the key and signing out other devices are SENSITIVE -- they need a recent
   re-authentication of the same session with the profile's recovery key. There is no time-window exemption (the
   lost-create-response rescue needs the creating page's receipt: escrow3aIdentity E). `key`, when given, re-authenticates
   first. */
const reauth = (port: number, cookie: string, recoveryKey: string) => post(port, "/gs/api/profile/reauth", cookie, { recoveryKey });
const rotateKey = async (port: number, cookie: string, key?: string) => {
  if (key !== undefined) assert.equal((await reauth(port, cookie, key)).status, 200, "re-authenticated");
  return post(port, "/gs/api/profile/recovery-key", cookie);
};
const signOutOthers = async (port: number, cookie: string, key?: string) => {
  if (key !== undefined) assert.equal((await reauth(port, cookie, key)).status, 200, "re-authenticated");
  return post(port, "/gs/api/profile/sign-out-others", cookie);
};
const signOut = (port: number, cookie: string) => post(port, "/gs/api/session/revoke", cookie);

/** A fresh browser redeems a credential; its new cookie on success. */
async function recoverOnFreshBrowser(port: number, recoveryKey: string): Promise<{ answer: ApiAnswer; before: string; cookie: string | null }> {
  const before = await bootstrapCookie(port);
  const answer = await recover(port, before, recoveryKey);
  return { answer, before, cookie: answer.status === 200 ? cookieFromAnswer(answer) : null };
}
async function linkOnFreshBrowser(port: number, code: string): Promise<{ answer: ApiAnswer; before: string; cookie: string | null }> {
  const before = await bootstrapCookie(port);
  const answer = await redeem(port, before, code);
  return { answer, before, cookie: answer.status === 200 ? cookieFromAnswer(answer) : null };
}

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
  const service = await IdentityService.open(createFileIdentityStore(dir, { warn: () => undefined }));
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

describe("LIVE-2E create", () => {
  test("the name is cleaned; the recovery key is rk_<selector>.<secret>, shown once and stored only as a digest; no id on the wire", async () => {
    const { service, store } = memoryService();
    const { server, port } = await prodServer({ service });
    try {
      const cookie = await bootstrapCookie(port);
      // Refused names: nothing usable, or not a name at all -- and neither spends anything durable.
      for (const [name, error] of [["", "bad-name"], ["   \t  ", "bad-name"], ["\u0000\u0007", "bad-name"]] as const) {
        const refused = await createProfile(port, cookie, name);
        assert.deepEqual([refused.status, refused.body], [400, { error }], JSON.stringify(name));
      }
      for (const name of [42, null, "x".repeat(257)]) assert.deepEqual((await createProfile(port, cookie, name)).body, { error: "bad-request" });
      assert.equal(store.snapshot().profiles.length, 0);

      const created = await createProfile(port, cookie, "  Ann\u0007   \t Lee  with a much too long surname  ");
      assert.equal(created.status, 201);
      assert.equal(created.headers["cache-control"], "no-store");
      assert.equal(created.headers["set-cookie"], undefined, "the browser keeps its cookie: its principal is now profiled");
      const body = created.body as { ok: boolean; profile: { name: string; otherSessions: number }; recoveryKey: string };
      // Control characters dropped, whitespace collapsed, cut to 24 characters, trimmed again.
      assert.deepEqual(body.profile, { name: "Ann Lee with a much too", otherSessions: 0 });
      assert.deepEqual(Object.keys(body).sort(), ["ok", "profile", "recoveryKey"]);
      assert.match(body.recoveryKey, RECOVERY_KEY_PATTERN);
      const [selector, secret] = body.recoveryKey.split(".");
      assert.ok(!/pr_|pf_|se_/.test(created.text.replace(body.recoveryKey, "")), "no principal, profile or session id on the wire");

      // Stored: the selector and SHA-256 of the secret -- never the key, never the secret.
      const snapshot = store.snapshot();
      assert.equal(snapshot.profiles.length, 1);
      const [profile] = snapshot.profiles;
      assert.equal(profile.recovery_selector, selector);
      assert.equal(profile.recovery_hash, secretHash(secret));
      assert.equal(profile.display_name, body.profile.name);
      assert.match(profile.profile_id, /^pf_/);
      const text = JSON.stringify(snapshot);
      assert.ok(!text.includes(secret) && !text.includes(body.recoveryKey), "no plaintext recovery key in the store");
      assert.ok(!JSON.stringify(service.peekProfileOf(profile.principal_id)).includes(secret));
      // Bound both ways, in the same commit: the principal is durable and names the profile.
      const principal = snapshot.principals.find((record) => record.principal_id === profile.principal_id);
      assert.deepEqual([principal?.kind, principal?.account_link], ["profile", profile.profile_id]);
      assert.equal(principal?.principal_id, principalOf(server, cookie));

      // The bootstrap now names the profile -- by name only.
      const again = await session(port, cookie);
      assert.deepEqual(again.body, { ok: true, expiresAt: (again.body as { expiresAt: number }).expiresAt, profile: { name: body.profile.name, otherSessions: 0 } });
      assert.ok(!/pr_|pf_|se_|rk_/.test(again.text));
      // Created once: a second attempt is told so, and makes nothing.
      const twice = await createProfile(port, cookie, "Somebody Else");
      assert.deepEqual([twice.status, twice.body], [409, { error: "already-profiled", profile: { name: body.profile.name } }]);
      assert.ok(!twice.text.includes("rk_"), "the recovery key is never shown again");
      assert.equal(store.snapshot().profiles.length, 1);
      // No cookie is not a profile request at all.
      assert.deepEqual((await createProfile(port, undefined, "Nobody")).body, { error: "not-authenticated" });
    } finally {
      await stopServer(server);
    }
  });

  test("retry and race: five concurrent creates on one cookie make exactly one profile (one 201, four 409); a second browser makes its own", async () => {
    const { service, store } = memoryService();
    const { server, port } = await prodServer({ service });
    try {
      const cookie = await bootstrapCookie(port);
      const answers = await Promise.all(["One", "Two", "Three", "Four", "Five"].map((name) => createProfile(port, cookie, name)));
      const statuses = answers.map((answer) => answer.status).sort();
      assert.deepEqual(statuses, [201, 409, 409, 409, 409]);
      const winner = answers.find((answer) => answer.status === 201) as ApiAnswer;
      const name = (winner.body as { profile: { name: string } }).profile.name;
      for (const loser of answers.filter((answer) => answer.status === 409)) {
        assert.deepEqual(loser.body, { error: "already-profiled", profile: { name } }, "every loser is told the winner's name, and no key");
      }
      assert.equal(store.snapshot().profiles.length, 1, "exactly one profile stored");
      assert.equal(service.stats.profilesCreated, 1);

      const other = await profiledBrowser(port, "Bea");
      const snapshot = store.snapshot();
      assert.equal(snapshot.profiles.length, 2);
      assert.notEqual(snapshot.profiles[0].principal_id, snapshot.profiles[1].principal_id, "a different principal");
      assert.notEqual(other.recoveryKey, (winner.body as { recoveryKey: string }).recoveryKey);
      assert.notEqual(principalOf(server, other.cookie), principalOf(server, cookie));
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
      for (const action of [linkCode, rotateKey, signOutOthers]) {
        const refused = await action(port, guest);
        assert.deepEqual([refused.status, refused.body], [403, { error: "profile-required" }]);
      }
      // Without any session they are not-authenticated (the client bootstraps first).
      for (const action of [linkCode, rotateKey, signOutOthers]) assert.deepEqual((await action(port, "")).body, { error: "not-authenticated" });
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
    RECOVERY
   ================================================================== */

describe("LIVE-2E recovery", () => {
  test("the right key: 200 + a cookie for the SAME principal, whose sockets see the same seat; the replaced cookie ends; other devices stay", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await profiledBrowser(port, "Ann");
      const table = await tableOf(port, ann.cookie, "ann-table");
      const annSocket = await Client.openWithCookie(port, ann.cookie, "ann");
      const before = await bootstrapCookie(port);
      assert.equal(((await session(port, before)).body as { profile: unknown }).profile, null, "unprofiled before (P3-ACCT: its socket would be a public one)");
      const answer = await recover(port, before, `  ${ann.recoveryKey}\n`);
      assert.equal(answer.status, 200, answer.text);
      assert.deepEqual(answer.body, { ok: true, profile: { name: "Ann" } });
      assert.ok(!/pr_|pf_|se_|rk_/.test(answer.text), "no id and no key in the answer");
      assert.equal(answer.headers["cache-control"], "no-store");
      const recovered = cookieFromAnswer(answer) as string;
      assert.match((answer.headers["set-cookie"] ?? [])[0], /; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=15552000$/);
      assert.notEqual(recovered, before);
      assert.equal(principalOf(server, recovered), principalOf(server, ann.cookie), "the SAME principal");
      // The same seat: the table the profile created, seen from the recovered browser.
      const view = await viewWith(port, recovered, table.gameId, "recovered");
      assert.deepEqual([view.you.role, view.you.playerId], ["host", table.playerId]);
      // The browser's temporary session is replaced: it bootstraps to session-ended, and upgrades nothing.
      const replaced = await session(port, before);
      assert.deepEqual([replaced.status, replaced.body], [401, { error: "session-ended", reason: "replaced" }]);
      assert.equal(await upgradeStatus(port, before), 401);
      assert.equal(server.identity.peekSession(sessionIdOfCookie(before))?.revoke_reason, "replaced");
      // The first device is untouched: its socket stays open, its cookie bootstraps and sees one other device.
      await sleep(30);
      assert.ok(annSocket.open, "another device's socket is not closed by a recovery");
      const first = await session(port, ann.cookie);
      assert.deepEqual((first.body as { profile: unknown }).profile, { name: "Ann", otherSessions: 1 });
      assert.equal(await upgradeStatus(port, ann.cookie), 101);
      // Already-profiled browsers cannot recover (either device), and nothing about them changes.
      for (const cookie of [ann.cookie, recovered]) {
        const again = await recover(port, cookie, ann.recoveryKey);
        assert.deepEqual([again.status, again.body], [409, { error: "already-profiled" }]);
      }
      const bea = await profiledBrowser(port, "Bea");
      assert.equal((await recover(port, bea.cookie, ann.recoveryKey)).status, 409, "a signed-in browser of another profile is refused too");
      assert.notEqual(principalOf(server, bea.cookie), principalOf(server, ann.cookie));
      assert.equal(((await session(port, bea.cookie)).body as { profile: { name: string } }).profile.name, "Bea", "Bea's browser is still Bea's");
      assert.equal(server.identity.stats.recoveries, 1);
      await annSocket.close();
    } finally {
      await stopServer(server);
    }
  });

  test("one answer for every wrong key: wrong selector, wrong secret, malformed, rotated away -- and none of them replaces the browser's session", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await profiledBrowser(port, "Ann");
      const [selector, secret] = ann.recoveryKey.split(".");
      const wrong = [
        `${mintRecoverySelector()}.${secret}`, // wrong selector, right secret
        `${selector}.${mintSecret()}`, // right selector, wrong secret
        `${mintRecoverySelector()}.${mintSecret()}`,
        "not a key",
        `${selector}.`,
        `${ann.recoveryKey}x`,
        ann.recoveryKey.toUpperCase(),
        "",
      ];
      const observed = new Set<string>();
      for (const key of wrong) {
        const { answer, before } = await recoverOnFreshBrowser(port, key);
        assert.deepEqual([answer.status, answer.body], [403, { error: "invalid-credential" }], key);
        assert.equal(answer.headers["set-cookie"], undefined);
        observed.add(observable(answer));
        const still = await session(port, before);
        assert.deepEqual([still.status, (still.body as { profile: unknown }).profile], [200, null], "the browser keeps its own session");
      }
      assert.equal(observed.size, 1, "status, headers and body are identical for every wrong key");

      // Rotation (after re-authenticating -- ESCROW-3A): the old key stops at once and answers exactly like any wrong
      // one; the new one works.
      const rotated = await rotateKey(port, ann.cookie, ann.recoveryKey);
      assert.equal(rotated.status, 200);
      const fresh = (rotated.body as { recoveryKey: string }).recoveryKey;
      assert.match(fresh, RECOVERY_KEY_PATTERN);
      assert.notEqual(fresh, ann.recoveryKey);
      assert.deepEqual(Object.keys(rotated.body as object).sort(), ["ok", "recoveryKey"]);
      const old = await recoverOnFreshBrowser(port, ann.recoveryKey);
      assert.equal(old.answer.status, 403);
      observed.add(observable(old.answer));
      assert.equal(observed.size, 1, "a rotated-away key is indistinguishable from a wrong one");
      const works = await recoverOnFreshBrowser(port, fresh);
      assert.equal(works.answer.status, 200);
      assert.equal(principalOf(server, works.cookie as string), principalOf(server, ann.cookie));
      assert.equal(server.identity.stats.credentialFailures, wrong.length + 1);
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    LINK CODES
   ================================================================== */

describe("LIVE-2E link codes", () => {
  test("a code signs a fresh browser in to the SAME principal, once; a replay is the wrong-code answer; case, spaces and hyphens are forgiven", async () => {
    const clock = { now: Date.now() };
    const { server, port } = await prodServer({ clock });
    try {
      const ann = await profiledBrowser(port, "Ann");
      const issued = await linkCode(port, ann.cookie);
      assert.equal(issued.status, 201);
      assert.equal(issued.headers["cache-control"], "no-store");
      const { code, expiresAt } = issued.body as { code: string; expiresAt: number };
      assert.match(code, LINK_CODE_DISPLAY);
      assert.equal(expiresAt, clock.now + 10 * 60 * 1000, "ten minutes");
      assert.deepEqual(Object.keys(issued.body as object).sort(), ["code", "expiresAt", "ok"]);
      assert.equal(server.identity.sizes().links, 1);

      const typed = ` ${code.toLowerCase().replace(/-/g, "").replace(/(.{5})/g, "$1 ")} `.replace(/0/g, "o").replace(/1/g, "l");
      const linked = await linkOnFreshBrowser(port, typed);
      assert.equal(linked.answer.status, 200, linked.answer.text);
      assert.deepEqual(linked.answer.body, { ok: true, profile: { name: "Ann" } });
      assert.equal(principalOf(server, linked.cookie as string), principalOf(server, ann.cookie), "the profile's own principal");
      assert.deepEqual((await session(port, linked.before)).body, { error: "session-ended", reason: "replaced" });

      const wrongCode = await linkOnFreshBrowser(port, "ABCD-EFGH-JKMN-PQRS-TVWX");
      const replay = await linkOnFreshBrowser(port, code);
      const malformed = await linkOnFreshBrowser(port, "not-a-code");
      for (const refused of [wrongCode, replay, malformed]) {
        assert.deepEqual([refused.answer.status, refused.answer.body], [403, { error: "invalid-credential" }]);
        assert.deepEqual((await session(port, refused.before)).status, 200, "a refused redemption replaces nothing");
      }
      assert.equal(observable(replay.answer), observable(wrongCode.answer), "a used code is indistinguishable from a wrong one");
      assert.equal(observable(malformed.answer), observable(wrongCode.answer));
      assert.equal(server.identity.stats.links, 1);
    } finally {
      await stopServer(server);
    }
  });

  test("expiry: a code works until its expiresAt and never at it (the identity clock)", async () => {
    const clock = { now: 1_760_000_000_000 };
    const { server, port } = await prodServer({ clock });
    try {
      const ann = await profiledBrowser(port, "Ann");
      const first = (await linkCode(port, ann.cookie)).body as { code: string; expiresAt: number };
      clock.now = first.expiresAt - 1;
      assert.equal((await linkOnFreshBrowser(port, first.code)).answer.status, 200, "a millisecond before");
      const second = (await linkCode(port, ann.cookie)).body as { code: string; expiresAt: number };
      clock.now = second.expiresAt;
      const late = await linkOnFreshBrowser(port, second.code);
      assert.deepEqual([late.answer.status, late.answer.body], [403, { error: "invalid-credential" }], "at expiry");
    } finally {
      await stopServer(server);
    }
  });

  test("a signed-in browser cannot redeem (409, the code survives); A's code gives A's principal, never B's; ONE code is outstanding", async () => {
    const { server, port, clock } = await prodServer();
    try {
      const ann = await profiledBrowser(port, "Ann");
      const bea = await profiledBrowser(port, "Bea");
      const beaPrincipal = principalOf(server, bea.cookie);
      const { code } = (await linkCode(port, ann.cookie)).body as { code: string };
      const refused = await redeem(port, bea.cookie, code);
      assert.deepEqual([refused.status, refused.body], [409, { error: "already-profiled" }]);
      assert.equal(refused.headers["set-cookie"], undefined);
      assert.equal(principalOf(server, bea.cookie), beaPrincipal, "Bea is still Bea");
      assert.equal((await redeem(port, ann.cookie, code)).status, 409, "nor the issuing browser itself");
      const linked = await linkOnFreshBrowser(port, code);
      assert.equal(linked.answer.status, 200, "the code was not spent by the refusals");
      assert.equal(principalOf(server, linked.cookie as string), principalOf(server, ann.cookie));
      assert.notEqual(principalOf(server, linked.cookie as string), principalOf(server, bea.cookie));

      // LIVE-2E review H1: a new code retires every earlier unused one -- in the same millisecond too -- so no device
      // can stockpile codes. Four issued; only the last works.
      const codes: string[] = [];
      for (let n = 0; n < 4; n += 1) {
        if (n === 2) clock.now += 1;
        codes.push(((await linkCode(port, ann.cookie)).body as { code: string }).code);
      }
      assert.equal(new Set(codes).size, 4);
      assert.equal(server.identity.sizes().links, 1, "one code held for a profile (the used one is dropped too)");
      for (const retired of codes.slice(0, 3)) assert.equal((await linkOnFreshBrowser(port, retired)).answer.status, 403, "retired");
      const outcome = await linkOnFreshBrowser(port, codes[3]);
      assert.equal(outcome.answer.status, 200);
      assert.equal(principalOf(server, outcome.cookie as string), principalOf(server, ann.cookie));
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
      const { code } = (await linkCode(port, ann.cookie)).body as { code: string };
      const phone = (await linkOnFreshBrowser(port, code)).cookie as string;
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
      assert.deepEqual((await linkCode(port, ann.cookie)).body, { error: "not-authenticated" });
      assert.deepEqual(((await session(port, phone)).body as { profile: unknown }).profile, { name: "Ann", otherSessions: 0 });
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
    try {
      let { server, port } = await fileServer(dir);
      const ann = await profiledBrowser(port, "Ann");
      const table = await tableOf(port, ann.cookie, "ann-table");
      const { code } = (await linkCode(port, ann.cookie)).body as { code: string };
      const phone = (await linkOnFreshBrowser(port, code)).cookie as string;
      const tablet = (await recoverOnFreshBrowser(port, ann.recoveryKey)).cookie as string;
      const sockets = {
        laptop: await Client.openWithCookie(port, ann.cookie, "laptop"),
        phone: await Client.openWithCookie(port, phone, "phone"),
        tablet: await Client.openWithCookie(port, tablet, "tablet"),
      };
      assert.deepEqual(((await session(port, tablet)).body as { profile: unknown }).profile, { name: "Ann", otherSessions: 2 });
      /* ESCROW-3A: the tablet's live session alone is not enough -- 403 reauth-required, nobody signed out. */
      assert.deepEqual((await signOutOthers(port, tablet)).body, { error: "reauth-required" });
      assert.deepEqual(((await session(port, tablet)).body as { profile: unknown }).profile, { name: "Ann", otherSessions: 2 });
      const done = await signOutOthers(port, tablet, ann.recoveryKey);
      assert.deepEqual([done.status, done.body], [200, { ok: true, signedOut: 2 }]);
      assert.equal(await sockets.laptop.closed, 4401);
      assert.equal(await sockets.phone.closed, 4401);
      await sleep(30);
      assert.ok(sockets.tablet.open);
      for (const ended of [ann.cookie, phone]) {
        assert.deepEqual((await session(port, ended)).body, { error: "session-ended", reason: "signed-out-remotely" });
        assert.equal(await upgradeStatus(port, ended), 401);
      }
      assert.deepEqual(((await session(port, tablet)).body as { profile: unknown }).profile, { name: "Ann", otherSessions: 0 });
      assert.equal((await viewWith(port, tablet, table.gameId, "tablet")).you.playerId, table.playerId, "nothing about the seats changed");
      assert.deepEqual((await signOutOthers(port, tablet)).body, { ok: true, signedOut: 0 }, "idempotent");
      await sockets.tablet.close();
      await stopServer(server);

      ({ server, port } = await fileServer(dir));
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
  test("a restart over the file store keeps profiles, a rotated key's invalidity, link-code consumption and revocations -- and no plaintext", async () => {
    const dir = tmpDir("restart");
    try {
      let { server, port } = await fileServer(dir);
      const ann = await profiledBrowser(port, "Ann");
      const table = await tableOf(port, ann.cookie, "ann-table");
      const used = ((await linkCode(port, ann.cookie)).body as { code: string }).code;
      const linked = await linkOnFreshBrowser(port, used);
      assert.equal(linked.answer.status, 200);
      const rotated = ((await rotateKey(port, ann.cookie, ann.recoveryKey)).body as { recoveryKey: string }).recoveryKey;
      assert.equal((await signOut(port, linked.cookie as string)).status, 204);
      // Issued after the rotation and the sign-out (each of which retires outstanding codes -- review H1).
      const unused = ((await linkCode(port, ann.cookie)).body as { code: string }).code;
      const principal = principalOf(server, ann.cookie);
      await stopServer(server);

      const file = readIdentityFile(dir);
      assert.equal(file.version, IDENTITY_FILE_VERSION);
      assert.equal((file.profiles as unknown[]).length, 1);
      const text = JSON.stringify(file);
      for (const secret of [ann.recoveryKey, ann.recoveryKey.split(".")[1], rotated, rotated.split(".")[1], used, unused, canonicalLinkCode(used) as string, canonicalLinkCode(unused) as string, ann.cookie.split(".")[2]]) {
        assert.ok(!text.includes(secret), "no key, code or cookie secret in identity.json");
      }
      assert.ok((file.links as Array<{ link_hash: string }>).some((link) => link.link_hash === linkCodeHash(canonicalLinkCode(unused) as string)), "a code is kept as its digest");

      ({ server, port } = await fileServer(dir));
      try {
        assert.deepEqual(((await session(port, ann.cookie)).body as { profile: unknown }).profile, { name: "Ann", otherSessions: 0 });
        assert.equal(principalOf(server, ann.cookie), principal);
        assert.equal((await recoverOnFreshBrowser(port, ann.recoveryKey)).answer.status, 403, "the rotated-away key stays dead");
        assert.equal((await linkOnFreshBrowser(port, used)).answer.status, 403, "the used code stays used");
        assert.deepEqual((await session(port, linked.cookie as string)).body, { error: "session-ended", reason: "logout" });
        const viaUnused = await linkOnFreshBrowser(port, unused);
        assert.equal(viaUnused.answer.status, 200, "an unused, unexpired code survives the restart");
        const viaKey = await recoverOnFreshBrowser(port, rotated);
        assert.equal(viaKey.answer.status, 200);
        for (const cookie of [viaUnused.cookie as string, viaKey.cookie as string]) {
          assert.equal(principalOf(server, cookie), principal);
          assert.equal((await viewWith(port, cookie, table.gameId, "after-restart")).you.playerId, table.playerId);
        }
      } finally {
        await stopServer(server);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a v1 identity.json migrates: its guest becomes unprofiled with its session and seats, and the next commit writes v2", async () => {
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

      const service = await IdentityService.open(createFileIdentityStore(dir, { warn: () => undefined }));
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
           ANOTHER profile would orphan them: recover and link are refused `has-tables`, and nothing is spent. */
        const other = await profiledBrowser(port, "Other");
        const otherCode = ((await linkCode(port, other.cookie)).body as { code: string }).code;
        assert.deepEqual([(await recover(port, cookie, other.recoveryKey)).body, (await redeem(port, cookie, otherCode)).body], [
          { error: "has-tables" },
          { error: "has-tables" },
        ]);
        assert.equal((await session(port, cookie)).status, 200, "its session was not replaced");
        assert.equal((await linkOnFreshBrowser(port, otherCode)).answer.status, 200, "the code was not spent");
        const created = await createProfile(port, cookie, "Old Guest");
        assert.equal(created.status, 201);
        const file = readIdentityFile(dir);
        assert.equal(file.version, 2, "the next commit writes v2");
        const stored = (file.principals as Array<{ principal_id: string; kind: string; account_link: string }>).find((p) => p.principal_id === principalId);
        assert.equal(stored?.kind, "profile", "the SAME principal is bound -- so its seats come with it");
        assert.ok((file.profiles as Array<{ principal_id: string }>).some((profile) => profile.principal_id === principalId));
        const view = await viewWith(port, cookie, record.game_id, "old-guest");
        assert.deepEqual([view.you.role, view.you.playerId], ["host", ALICE], "the seat it held before profiles existed");
      } finally {
        await stopServer(server);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a half-bound profile refuses to load (either side), as does a link code naming no profile", async () => {
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
      const cases: Array<[string, object]> = [
        ["a profile principal naming no stored profile", doc([principal(p1, "profile", f1)], [])],
        ["a profile whose principal is unprofiled", doc([principal(p1, "unprofiled", null)], [profile(f1, p1)])],
        ["a profile naming no stored principal", doc([], [profile(f1, p1)])],
        ["a principal naming another profile than the one naming it", doc([principal(p1, "profile", f2)], [profile(f1, p1), profile(f2, p2)])],
        ["two profiles for one principal", doc([principal(p1, "profile", f1)], [profile(f1, p1), profile(f2, p1)])],
        ["a link code naming no profile", doc([principal(p1, "profile", f1)], [profile(f1, p1)], [link(f2)])],
        ["a v1 principal that is not a guest", { format: "gs-identity", version: 1, principals: [principal(p1, "profile", f1)], sessions: [] }],
        ["a v2 document without its profile collections", { format: "gs-identity", version: 2, principals: [], sessions: [] }],
      ];
      for (const [what, bad] of cases) {
        fs.writeFileSync(path.join(dir, IDENTITY_FILE), JSON.stringify(bad));
        await assert.rejects(createFileIdentityStore(dir).load(), (error: Error) => error instanceof IdentityStoreCorruptError, what);
        await assert.rejects(IdentityService.open(createFileIdentityStore(dir)), IdentityStoreCorruptError, what);
      }
      // The well-bound pair loads.
      fs.writeFileSync(path.join(dir, IDENTITY_FILE), JSON.stringify(doc([principal(p1, "profile", f1)], [profile(f1, p1)], [link(f1)])));
      const loaded = await IdentityService.open(createFileIdentityStore(dir));
      assert.equal(loaded.isProfiled(p1), true);
      assert.equal(loaded.profileName(p1), "Ann");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an injected store failure on create, recover, link, rotate, link-code and sign-out-others answers 503 and changes nothing", async () => {
    const { service, store } = memoryService();
    const { server, port } = await prodServer({ service });
    const fail = () => store.failNext.push("definite");
    const durable = () => JSON.stringify(store.snapshot());
    try {
      const ann = await profiledBrowser(port, "Ann");
      // Create.
      const bea = await bootstrapCookie(port);
      let before = durable();
      fail();
      const refusedCreate = await createProfile(port, bea, "Bea");
      assert.deepEqual([refusedCreate.status, refusedCreate.body], [503, { error: "unavailable" }]);
      assert.ok(refusedCreate.headers["retry-after"]);
      assert.equal(durable(), before);
      assert.equal(((await session(port, bea)).body as { profile: unknown }).profile, null, "no profile half-created");
      assert.equal(await upgradeStatus(port, bea), 101, "P3-ACCT: still only a public, read-only socket");
      assert.equal((await createProfile(port, bea, "Bea")).status, 201, "the retry creates it (not already-profiled)");

      // Link-code issue.
      before = durable();
      fail();
      assert.equal((await linkCode(port, ann.cookie)).status, 503);
      assert.equal(durable(), before);
      const { code } = (await linkCode(port, ann.cookie)).body as { code: string };

      // Link.
      const phone = await bootstrapCookie(port);
      before = durable();
      fail();
      const refusedLink = await redeem(port, phone, code);
      assert.deepEqual([refusedLink.status, refusedLink.body], [503, { error: "unavailable" }]);
      assert.equal(refusedLink.headers["set-cookie"], undefined);
      assert.equal(durable(), before, "the code is not consumed");
      assert.equal((await session(port, phone)).status, 200, "the browser's session was not replaced");
      const linked = await redeem(port, phone, code);
      assert.equal(linked.status, 200, "the code is still redeemable");
      assert.equal(principalOf(server, cookieFromAnswer(linked) as string), principalOf(server, ann.cookie));

      // Recover.
      const tablet = await bootstrapCookie(port);
      before = durable();
      fail();
      assert.equal((await recover(port, tablet, ann.recoveryKey)).status, 503);
      assert.equal(durable(), before);
      assert.equal(((await session(port, tablet)).body as { profile: unknown }).profile, null);
      const recovered = await recover(port, tablet, ann.recoveryKey);
      assert.equal(recovered.status, 200);

      // Rotate: the old key keeps working after a refused rotation.
      before = durable();
      fail();
      assert.equal((await rotateKey(port, ann.cookie, ann.recoveryKey)).status, 503, "re-authenticated (no write), then the rotation's write fails");
      assert.equal(durable(), before);
      assert.equal((await recoverOnFreshBrowser(port, ann.recoveryKey)).answer.status, 200, "the old key still works");

      // Sign out other devices: nobody is signed out.
      const phoneCookie = cookieFromAnswer(linked) as string;
      before = durable();
      fail();
      assert.equal((await reauth(port, ann.cookie, ann.recoveryKey)).status, 200); // writes nothing: the fault stays armed
      assert.equal((await signOutOthers(port, ann.cookie)).status, 503);
      assert.equal(durable(), before);
      assert.equal((await session(port, phoneCookie)).status, 200);
      assert.equal(await upgradeStatus(port, phoneCookie), 101);
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    BUDGETS
   ================================================================== */

describe("LIVE-2E rate limits", () => {
  test("credential redemptions: the address budget counts FAILURES and never refuses the right credential (ESCROW-3A §10C); apart from every room limit", async () => {
    const { server, port } = await prodServer({
      limits: { credentialRedeemsPerIp: { capacity: 3, refillPerSecond: 0.0001 } },
      rooms: { createsPerIp: { capacity: 1, refillPerSecond: 0.0001 } },
    });
    try {
      const ann = await profiledBrowser(port, "Ann");
      // The room budget is spent first: it touches no redemption.
      const socket = await Client.openWithCookie(port, ann.cookie, "ann");
      const table = await socket.op(CREATE());
      assert.equal(table.ok, true);
      const { gameId } = table.data as { gameId: string };
      assert.equal((await socket.op(CREATE())).code, "rate-limited");
      const { code } = (await linkCode(port, ann.cookie)).body as { code: string };
      // A neighbour on the same address spends the address's FAILURE budget (3) with wrong credentials ...
      assert.equal((await recoverOnFreshBrowser(port, `${mintRecoverySelector()}.${mintSecret()}`)).answer.status, 403);
      assert.equal((await linkOnFreshBrowser(port, "ABCD-EFGH-JKMN-PQRS-TVWX")).answer.status, 403);
      assert.equal((await recoverOnFreshBrowser(port, `${ann.recoveryKey.split(".")[0]}.${mintSecret()}`)).answer.status, 403);
      // ... after which every WRONG credential is 429 -- a real selector with a wrong secret and an unknown one alike ...
      const limited = await recoverOnFreshBrowser(port, `${mintRecoverySelector()}.${mintSecret()}`);
      assert.equal(limited.answer.status, 429);
      assert.equal((limited.answer.body as { error: string }).error, "rate-limited");
      assert.ok(Number(limited.answer.headers["retry-after"]) >= 1);
      const realSelector = await recoverOnFreshBrowser(port, `${ann.recoveryKey.split(".")[0]}.${mintSecret()}`);
      assert.deepEqual([realSelector.answer.status, realSelector.answer.body], [limited.answer.status, limited.answer.body], "no existence oracle");
      assert.equal(server.identityLimiter.denied["credential-ip"], 2);
      assert.equal((await session(port, limited.before)).status, 200, "a refused redemption replaces nothing");
      // ... and the RIGHT credentials still sign in: the right key, and a valid link code.
      assert.equal((await recoverOnFreshBrowser(port, ann.recoveryKey)).answer.status, 200, "the right key is never refused on the address budget");
      assert.equal((await linkOnFreshBrowser(port, code)).answer.status, 200, "nor a valid code");
      // And the rooms are untouched by it: the same player's socket still acts.
      assert.equal((await socket.op({ type: "set-ready", ready: true }, gameId)).ok, true);
      await socket.close();
    } finally {
      await stopServer(server);
    }
    /* LIVE-2E review M1: there is NO server-wide redemption budget -- it would let a few addresses switch recovery off
       for everybody. The second budget is the SESSION's: one browser cannot guess on past its own allowance. */
    const perSession = await prodServer({ limits: { credentialRedeemsPerSession: { capacity: 2, refillPerSecond: 0.0001 } } });
    try {
      const guesser = await bootstrapCookie(perSession.port);
      for (let n = 0; n < 2; n += 1) assert.equal((await redeem(perSession.port, guesser, "ABCD-EFGH-JKMN-PQRS-TVWX")).status, 403);
      assert.equal((await redeem(perSession.port, guesser, "ABCD-EFGH-JKMN-PQRS-TVWX")).status, 429);
      assert.equal(perSession.server.identityLimiter.denied["credential-session"], 1);
      // Another browser (same address) is not held back by that session's guessing.
      assert.equal((await linkOnFreshBrowser(perSession.port, "ABCD-EFGH-JKMN-PQRS-TVWX")).answer.status, 403);
    } finally {
      await stopServer(perSession.server);
    }
  });

  test("profile creations are budgeted per address; a refused one creates nothing; profile actions per SESSION", async () => {
    const { service, store } = memoryService();
    const { server, port } = await prodServer({
      service,
      limits: { profileCreatesPerIp: { capacity: 2, refillPerSecond: 0.0001 }, profileActionsPerSession: { capacity: 3, refillPerSecond: 0.0001 } },
    });
    try {
      const ann = await profiledBrowser(port, "Ann");
      await profiledBrowser(port, "Bea");
      const third = await bootstrapCookie(port);
      const limited = await createProfile(port, third, "Cy");
      assert.equal(limited.status, 429);
      assert.ok(limited.headers["retry-after"]);
      assert.equal(server.identityLimiter.denied["profile-create-ip"], 1);
      assert.equal(store.snapshot().profiles.length, 2);
      assert.equal(((await session(port, third)).body as { profile: unknown }).profile, null);
      // Profile actions: three (a link code, a re-authentication, a rotation), then 429 for this SESSION (LIVE-2E review H1) ...
      const { code } = (await linkCode(port, ann.cookie)).body as { code: string };
      assert.equal((await rotateKey(port, ann.cookie, ann.recoveryKey)).status, 200);
      assert.equal((await signOutOthers(port, ann.cookie)).status, 429);
      assert.equal(server.identityLimiter.denied["profile-actions"], 1);
      // ... and another device of the same profile keeps its own: spending one device's budget cannot stop the
      // owner's other device from signing it out. (The rotation retired the code, so this device comes by recovery.)
      assert.equal((await linkOnFreshBrowser(port, code)).answer.status, 403, "the rotation retired the outstanding code");
      assert.equal((await signOutOthers(port, ann.cookie)).status, 429);
    } finally {
      await stopServer(server);
    }
  });

  test("LIVE-2E review H1: a leaked link code cannot outlive the owner securing the account", async () => {
    const { server, port } = await prodServer();
    try {
      const ann = await profiledBrowser(port, "Ann");
      // The intruder redeems a leaked code, then mints another to come back with.
      const leaked = ((await linkCode(port, ann.cookie)).body as { code: string }).code;
      const intruder = await linkOnFreshBrowser(port, leaked);
      assert.equal(intruder.answer.status, 200);
      const spare = ((await linkCode(port, intruder.cookie as string)).body as { code: string }).code;
      // The owner signs out other devices: the intruder's session ends AND its spare code dies with it.
      assert.deepEqual((await signOutOthers(port, intruder.cookie as string)).body, { error: "reauth-required" }, "ESCROW-3A: the intruder cannot sign the owner out");
      assert.equal((await rotateKey(port, intruder.cookie as string)).status, 403, "nor rotate the key (a live session alone never does)");
      assert.equal((await signOutOthers(port, ann.cookie, ann.recoveryKey)).status, 200);
      assert.equal((await session(port, intruder.cookie as string)).status, 401);
      assert.equal((await linkOnFreshBrowser(port, spare)).answer.status, 403, "the pre-minted code is gone");
      // The same holds for a key rotation and for a sign-out of the issuing device.
      const again = ((await linkCode(port, ann.cookie)).body as { code: string }).code;
      assert.equal((await rotateKey(port, ann.cookie)).status, 200);
      assert.equal((await linkOnFreshBrowser(port, again)).answer.status, 403, "a rotation retires outstanding codes");
      const phone = await linkOnFreshBrowser(port, ((await linkCode(port, ann.cookie)).body as { code: string }).code);
      assert.equal(phone.answer.status, 200);
      const fromPhone = ((await linkCode(port, phone.cookie as string)).body as { code: string }).code;
      assert.equal((await signOut(port, phone.cookie as string)).status, 204);
      assert.equal((await linkOnFreshBrowser(port, fromPhone)).answer.status, 403, "a sign-out retires outstanding codes");
      assert.equal(server.identity.sizes().links, 0);
    } finally {
      await stopServer(server);
    }
  });
});

/* ==================================================================
    NOTHING SECRET IS PRINTED
   ================================================================== */

describe("LIVE-2E nothing secret reaches a log line", () => {
  test("a whole profile lifecycle, with refusals and store failures, prints no recovery key, link code, cookie or digest", async () => {
    const lines: string[] = [];
    const saved = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...args: unknown[]) => lines.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(" "));
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    const { service, store } = memoryService();
    const secrets: string[] = [];
    const keep = (cookie: string | null) => {
      if (cookie) secrets.push(cookie, cookie.split(".")[2]);
    };
    const { server, port } = await prodServer({ service });
    try {
      const annCookie = await bootstrapCookie(port);
      keep(annCookie);
      store.failNext.push("definite");
      await createProfile(port, annCookie, "Ann");
      const created = await createProfile(port, annCookie, "Ann");
      const key = (created.body as { recoveryKey: string }).recoveryKey;
      secrets.push(key, key.split(".")[1]);
      const socket = await Client.openWithCookie(port, annCookie, "ann");
      await socket.op(CREATE());
      const code = ((await linkCode(port, annCookie)).body as { code: string }).code;
      secrets.push(code, canonicalLinkCode(code) as string, linkCodeHash(canonicalLinkCode(code) as string));
      const phone = await linkOnFreshBrowser(port, code.toLowerCase());
      keep(phone.before);
      keep(phone.cookie);
      await linkOnFreshBrowser(port, code); // a replay
      await recoverOnFreshBrowser(port, `${key}x`); // a malformed key
      await recoverOnFreshBrowser(port, `${key.split(".")[0]}.${mintSecret()}`); // a wrong secret
      store.failNext.push("definite");
      await recoverOnFreshBrowser(port, key);
      const tablet = await recoverOnFreshBrowser(port, key);
      keep(tablet.before);
      keep(tablet.cookie);
      store.failNext.push("definite");
      await rotateKey(port, annCookie, key); // re-authenticated; this rotation's write fails
      const rotated = ((await rotateKey(port, annCookie)).body as { recoveryKey: string }).recoveryKey; // the grant still stands
      secrets.push(rotated, rotated.split(".")[1]);
      await signOutOthers(port, annCookie, rotated);
      await signOut(port, annCookie);
      await socket.closed;
      for (const profile of store.snapshot().profiles) secrets.push(profile.recovery_hash);
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
    assert.ok(!/rk_[0-9a-z]{26}/.test(printed), "no recovery selector either");
  });
});

/* ==================================================================
    SEAT CONTINUITY (the brief's ten steps)
   ================================================================== */

describe("LIVE-2E seat continuity across devices, a sign-out, a restart and a recovery", () => {
  test("one seat, one principal: linked device, sign-out, restart, recovery -- the same player_id and log, and nothing copied or moved", async () => {
    const dir = tmpDir("continuity");
    const boot = async () => {
      const service = await IdentityService.open(createFileIdentityStore(dir, { warn: () => undefined }));
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

      // 4. A links a second device.
      const { code: link } = (await linkCode(port, ann.cookie)).body as { code: string };
      const phoneCookie = (await linkOnFreshBrowser(port, link)).cookie as string;
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

      // 9. Restart over the same directory; A recovers on a fresh browser with the recovery key.
      ({ server, port } = await boot());
      assert.deepEqual((await session(port, ann.cookie)).body, { error: "session-ended", reason: "logout" }, "the signed-out laptop stays out");
      const recovered = await recoverOnFreshBrowser(port, ann.recoveryKey);
      assert.equal(recovered.answer.status, 200);
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
