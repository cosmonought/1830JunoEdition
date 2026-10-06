// server/src/persistence/conformance/l6_1Routing.dynamoLocal.test.ts
//
// ==================================================================
//  LIVE-6 L6-1: THE IDENTITY VERIFIER, THE DIRECTORY AND THE NON-PRIMARY TASK -- ON DYNAMODB LOCAL
// ==================================================================
//
// Runs ONLY against a DynamoDB Local named by GS_DYNAMODB_LOCAL_ENDPOINT (`npm run test:dynamodb-local`); without one it
// FAILS with instructions.
//
//   §1 the verifier over a REAL identity table written by the REAL identity writer (L5-4's store and the identity
//      service): it verifies a real session read-only; it sends nothing but strongly consistent GetItems, never of the
//      role item; the table is byte-for-byte unchanged after it; a revocation, a family sign-out and a disabled principal
//      committed by the writer are seen at the next question; a damaged item, a missing family and an unreadable table
//      fail closed.
//   §2 the directory over a REAL game table: a HEAD claimed by a pool, released, damaged or absent; the routing, and a
//      routing item this build cannot read -- no destination is ever guessed.
//   §3 the composition: a primary task (pool p0) and a non-primary task (pool p1, runtime document v2) on the same
//      tables. A browser profiled on the primary opens a socket on the non-primary one: authenticated by the verifier,
//      routed to p0's trusted path -- and the game and identity tables are unchanged by it (the non-primary task took its
//      own pool and nothing else: no identity-writer role, no claim). Then the pipeline flips the routing to p1: the
//      non-primary task and the primary each end gracefully with exit 5 (the demoted primary releasing its resident
//      no-money game); the restarted p1 task takes the identity-writer role (epoch 2, pool p1) through the startup order
//      and claims the released game, and a restarted p0 task comes back non-primary.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DeleteItemCommand, PutItemCommand, ScanCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { WebSocket } from "ws";

import { createDynamoDbClient, deadline, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../../aws/awsClients";
import { claimGame, releaseGame, takeOverPool } from "../../aws/game/ownership";
import { headKey, readHead } from "../../aws/game/gameTable";
import { bootstrapGenerationMarker, generationMarkerItem } from "../../aws/game/generationMarker";
import { readRouting, ROUTING_KEY, setPrimaryPool } from "../../aws/game/routing";
import { createDynamoIdentityStore, readIdentityRole, takeOverIdentityWriter } from "../../aws/identity/dynamoIdentityStore";
import { keyAttributes, keys } from "../../aws/identity/identityItems";
import { createDynamoIdentityVerifier } from "../../aws/identity/identityVerifier";
import { LEDGER_KEYS } from "../../aws/ledger/dynamoSigningLedger";
import { poolGameDirectory } from "../../aws/ownership/gameDirectory";
import { EXIT_ROLE_CHANGED, startAwsRuntime, type AwsRuntime } from "../../aws/runtime/awsRuntime";
import { realAwsSubstrate } from "../../aws/runtime/awsSubstrate";
import { AWS_RUNTIME_CONFIG_FORMAT_V2, parseAwsRuntimeConfig } from "../../aws/runtime/runtimeConfig";
import { readSessionCookie, type SessionCookieRead } from "../../identity/cookies";
import { IdentityService } from "../../identity/sessions";
import { createAccountWith, keplrAccount } from "../../testSupport/authorizationWallets";
import type { Session } from "../../identity/store";
import { createMemoryOpsRecorder } from "../opsRecorder";
import { poolRoutes, routeOfGame } from "../../rooms/gameRoutes";
import type { GameRecord } from "../../rooms/gameRecord";
import { ALICE, BOB, quietConsole, seededRecord } from "../../rooms/testSupport";
import { clientAnnouncementQuery } from "../../../../frontend/src/gameEngine/compat/clientCompatibility";
import { CLIENT_ANSWER_CLOSE_CODE } from "../../../../frontend/src/utils/clientAnswers";
import { ConformanceTables, newRunId, requireLocal } from "./dynamoLocal";

const target = dynamoLocalTargetFromEnv();
if (target === null) {
  throw new Error(
    `${DYNAMODB_LOCAL_ENV} is not set. Start DynamoDB Local on this machine and point the suite at it, e.g.\n` +
      `  docker run --rm -p 127.0.0.1:8000:8000 amazon/dynamodb-local:3.3.1 -jar DynamoDBLocal.jar -inMemory\n` +
      `  ${DYNAMODB_LOCAL_ENV}=http://127.0.0.1:8000 npm run test:dynamodb-local\n` +
      "(server/src/aws/README.md has the Java route and the Windows PowerShell spelling).",
  );
}
const TARGET = target;
const admin: DynamoDBClient = createDynamoDbClient(TARGET);
const tables = new ConformanceTables(admin, newRunId());
const clients: DynamoDBClient[] = [];
const N = (value: number): AttributeValue => ({ N: String(value) });
const S = (value: string): AttributeValue => ({ S: value });

quietConsole();

after(async () => {
  for (const client of clients) client.destroy();
  await tables.dropAll();
  assert.deepEqual(tables.live, [], "every table this run made was dropped");
  admin.destroy();
});

async function freshClient(): Promise<DynamoDBClient> {
  const client = createDynamoDbClient(TARGET);
  await requireLocal(client);
  clients.push(client);
  return client;
}

/** A client that records every command it sends (its name and input). */
async function spyClient(): Promise<{ client: DynamoDBClient; sent: Array<{ name: string; input: Record<string, unknown> }> }> {
  const client = await freshClient();
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  client.middlewareStack.add(
    (next, context) => async (args) => {
      sent.push({ name: String((context as { commandName?: string }).commandName), input: args.input as Record<string, unknown> });
      return next(args);
    },
    { step: "initialize", name: "l6-1-spy" },
  );
  return { client, sent };
}

/** Every item of a table, canonically (for "nothing changed"). */
async function tableBytes(table: string): Promise<string> {
  const items: Array<Record<string, AttributeValue>> = [];
  let start: Record<string, AttributeValue> | undefined;
  do {
    const page = await admin.send(new ScanCommand({ TableName: table, ConsistentRead: true, ExclusiveStartKey: start }), { abortSignal: deadline() });
    items.push(...((page.Items ?? []) as Array<Record<string, AttributeValue>>));
    start = page.LastEvaluatedKey as Record<string, AttributeValue> | undefined;
  } while (start !== undefined);
  const canonical = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])])) : value;
  return JSON.stringify(items.map(canonical).map((item) => JSON.stringify(item)).sort());
}

const readOf = (setCookie: string): SessionCookieRead => readSessionCookie(setCookie.split(";")[0]);
const T0 = Date.now();
/** PHASE 3 FINAL: every account's password (test KDF parameters keep the writer fast). */
const PASSWORD = "correct horse battery";
const TEST_KDF = { passwordKdf: { logN: 10, r: 1, p: 1 } };

/** The identity WRITER on a real identity table (L5-4's store, the identity service), and a profiled browser of it. */
async function writerOn(table: string) {
  const { epoch } = await takeOverIdentityWriter(admin, table, { task: "t-writer", pool: "p0", now: () => T0 });
  const store = createDynamoIdentityStore(await freshClient(), table, { epoch, warn: () => undefined });
  const writer = await IdentityService.open(store, { policy: TEST_KDF });
  /** An account (username, password, Authorization Wallet): the create signs this browser in on a FRESH session. */
  const browser = async (name: string) => {
    const boot = await writer.bootstrap({ kind: "none" }, false, T0);
    const username = name.toLowerCase();
    const created = await createAccountWith(writer, readOf((boot as { setCookie: string }).setCookie), { username, password: PASSWORD, displayName: name, wallet: keplrAccount(`l6-1-dynamo/${name}`) }, T0);
    assert.equal(created.kind, "ok", JSON.stringify(created));
    const setCookie = (created as { setCookie: string }).setCookie;
    const read = readOf(setCookie);
    const sessionId = read.kind === "session" ? read.sessionId : "";
    return { read, cookie: setCookie.split(";")[0], sessionId, principalId: (writer.peekSession(sessionId) as Session).principal_id, username };
  };
  return { writer, browser };
}

/* ==================================================================
    §1 THE VERIFIER ON A REAL IDENTITY TABLE
   ================================================================== */
describe("§1 the identity verifier on the real identity table: read-only, strong, fail closed", () => {
  test("a real durable session verified with strong GetItems only -- never the role item -- and the table byte-for-byte unchanged", async () => {
    const table = await tables.create("verifier-identity");
    const { writer, browser } = await writerOn(table);
    const ann = await browser("Ann");
    const { client, sent } = await spyClient();
    const verifier = createDynamoIdentityVerifier(client, table);
    const before = await tableBytes(table);
    const role = await readIdentityRole(admin, table);
    for (let at = 0; at < 5; at += 1) {
      const auth = await verifier.authenticate(ann.read, T0 + 1 + at);
      assert.equal(auth.kind, "ok", JSON.stringify(auth));
      if (auth.kind !== "ok") return;
      assert.deepEqual([auth.principalId, auth.sessionId, auth.profiled, auth.provisional], [ann.principalId, ann.sessionId, true, false]);
      const frame = await verifier.recheck({ principalId: auth.principalId, sessionId: auth.sessionId, sessionExpiresAt: auth.sessionExpiresAt }, T0 + 2 + at);
      assert.deepEqual(frame, { kind: "ok", profiled: true });
    }
    assert.ok(sent.length > 0);
    assert.deepEqual([...new Set(sent.map((command) => command.name))], ["GetItemCommand"], "nothing but GetItem: no write, transaction, scan, query or condition check");
    for (const command of sent) {
      assert.equal(command.input.ConsistentRead, true, "every read strongly consistent");
      assert.notEqual((command.input.Key as { pk?: { S?: string } }).pk?.S, "ROLE#identity-writer", "the identity-writer role is never read, taken or named");
    }
    assert.equal(await tableBytes(table), before, "the identity table is unchanged");
    assert.deepEqual(await readIdentityRole(admin, table), role, "the writer's role is exactly as it was");
    void writer;
  });

  test("what the writer commits is seen at the next question: a logout, a family signed out remotely, a disabled principal", async () => {
    const table = await tables.create("verifier-changes");
    const { writer, browser } = await writerOn(table);
    const ann = await browser("Ann");
    const bob = await browser("Bob");
    const verifier = createDynamoIdentityVerifier(await freshClient(), table);
    /* Ann's phone (PHASE 3 FINAL: a sign-in with her username and password -- its own family), then "sign out other
       devices" from her first browser. */
    const phoneBoot = await writer.bootstrap({ kind: "none" }, false, T0 + 10);
    const phone = readOf(((await writer.login(readOf((phoneBoot as { setCookie: string }).setCookie), { username: ann.username, password: PASSWORD }, T0 + 10)) as { setCookie: string }).setCookie);
    const phoneAuth = await verifier.authenticate(phone, T0 + 11);
    assert.equal(phoneAuth.kind, "ok");
    assert.equal((await writer.reauthenticateWithPassword(ann.read, PASSWORD, T0 + 12)).kind, "ok");
    assert.equal((await writer.signOutOthers(ann.read, T0 + 12)).kind, "ok");
    assert.deepEqual(await verifier.authenticate(phone, T0 + 13), { kind: "refused", why: "ended" }, "the signed-out family");
    if (phoneAuth.kind === "ok") assert.deepEqual(await verifier.recheck({ principalId: phoneAuth.principalId, sessionId: phoneAuth.sessionId, sessionExpiresAt: phoneAuth.sessionExpiresAt }, T0 + 13), { kind: "revoked" });
    assert.equal((await verifier.authenticate(ann.read, T0 + 13)).kind, "ok", "the browser that signed the others out stays");
    assert.equal(await writer.revoke(ann.sessionId, "logout", T0 + 14), true);
    assert.deepEqual(await verifier.authenticate(ann.read, T0 + 15), { kind: "refused", why: "ended" }, "a logout");
    assert.equal(await writer.disablePrincipal(bob.principalId, T0 + 16), true);
    assert.deepEqual(await verifier.authenticate(bob.read, T0 + 17), { kind: "refused", why: "ended" }, "a disabled principal");
  });

  test("fail closed: a damaged item, a missing family, a table that cannot be read -- `unavailable`, never `ok`", async () => {
    const table = await tables.create("verifier-damage");
    const { browser } = await writerOn(table);
    const ann = await browser("Ann");
    const bob = await browser("Bob");
    const verifier = createDynamoIdentityVerifier(await freshClient(), table);
    /* Ann's session item gets an attribute this layout does not have (another build's, or damage). */
    const scan = await admin.send(new ScanCommand({ TableName: table, ConsistentRead: true }), { abortSignal: deadline() });
    const annItem = (scan.Items ?? []).find((item) => item.pk?.S === `SESS#${ann.sessionId}`) as Record<string, AttributeValue>;
    await admin.send(new PutItemCommand({ TableName: table, Item: { ...annItem, extra: S("x") } }), { abortSignal: deadline() });
    const damaged = await verifier.authenticate(ann.read, T0 + 1);
    assert.equal(damaged.kind, "unavailable", JSON.stringify(damaged));
    assert.doesNotMatch((damaged as { detail: string }).detail, /se_|pr_|sf_|pf_/, "the detail names a class, never an id");
    /* Bob's family item is gone (the records disagree). */
    const bobSession = (scan.Items ?? []).find((item) => item.pk?.S === `SESS#${bob.sessionId}`) as Record<string, AttributeValue>;
    await admin.send(new DeleteItemCommand({ TableName: table, Key: keyAttributes(keys.family(bobSession.family_id?.S as string)) }), { abortSignal: deadline() });
    assert.equal((await verifier.authenticate(bob.read, T0 + 1)).kind, "unavailable");
    /* A table that cannot be read at all. */
    const nowhere = createDynamoIdentityVerifier(await freshClient(), `${table}-missing`);
    assert.equal((await nowhere.authenticate(bob.read, T0 + 1)).kind, "unavailable");
  });
});

/* ==================================================================
    §2 THE DIRECTORY ON A REAL GAME TABLE
   ================================================================== */
describe("§2 the directory: the owner from a strong HEAD read, the primary from the routing -- nothing guessed", () => {
  test("claimed, released, damaged, absent; the routing, and a routing item this build cannot read", async () => {
    const game = await tables.create("directory-game");
    const routes = poolRoutes("p1", { p0: { wsPath: "/gs/p/p0" }, p1: { wsPath: "/gs/p/p1" }, p2: { wsPath: "/gs/p/p2" } });
    const client = await freshClient();
    const taken = await takeOverPool(admin, game, "p2", "t-p2", 1);
    assert.equal(taken.kind, "taken");
    const p2 = taken as { kind: "taken"; epoch: number };
    /* A game p2 created (its HEAD), claimed by p2. */
    const owned = seededRecord([ALICE, BOB]).game_id;
    const released = seededRecord([ALICE, BOB]).game_id;
    const damaged = seededRecord([ALICE, BOB]).game_id;
    for (const gameId of [owned, released]) {
      await admin.send(new PutItemCommand({ TableName: game, Item: { ...headKey(gameId), owner_pool: S("p2"), pool_epoch: N(p2.epoch), owner_task: S("t-p2"), log_next_index: N(0), log_bytes: N(0) } }), { abortSignal: deadline() });
      assert.equal((await claimGame(admin, game, gameId, { pool: "p2", epoch: p2.epoch, task: "t-p2" })).kind, "claimed");
    }
    assert.equal(await releaseGame(admin, game, released, { pool: "p2", epoch: p2.epoch }), true);
    await admin.send(new PutItemCommand({ TableName: game, Item: { ...headKey(damaged), log_next_index: N(0) } }), { abortSignal: deadline() });
    const directory = poolGameDirectory({ client, table: game, fence: { pool: "p1", epoch: 1 } });
    assert.deepEqual(await directory.ownerOf(owned), { kind: "owned", pool: "p2" });
    assert.deepEqual(await directory.ownerOf(released), { kind: "released" });
    await assert.rejects(directory.ownerOf(damaged), /damage, not an owner/);
    assert.deepEqual(await directory.ownerOf(seededRecord([ALICE]).game_id), { kind: "absent" });
    assert.equal(await directory.primaryPool(), null, "no routing yet");
    assert.deepEqual(await routeOfGame(released, directory, routes), { kind: "none", why: "no-primary" });
    assert.equal((await setPrimaryPool(admin, game, { pool: "p0", expectedVersion: null, by: "pipeline", now: 1 })).kind, "set");
    assert.deepEqual(await routeOfGame(owned, directory, routes), { kind: "route", pool: "p2", destination: { wsPath: "/gs/p/p2" } });
    assert.deepEqual(await routeOfGame(released, directory, routes), { kind: "route", pool: "p0", destination: { wsPath: "/gs/p/p0" } });
    assert.deepEqual(await routeOfGame(damaged, directory, routes), { kind: "none", why: "unreadable" });
    /* A routing item of another layout: refused whole, never read as a primary. */
    const current = await readRouting(admin, game);
    await admin.send(new PutItemCommand({ TableName: game, Item: { ...ROUTING_KEY, fmt: N(2), primary_pool: S("p0"), routing_version: N((current?.routing_version ?? 1) + 1), updated_at: N(2), updated_by: S("x"), claim: S("c") } }), { abortSignal: deadline() });
    assert.deepEqual(await routeOfGame(released, directory, routes), { kind: "none", why: "unreadable" });
    assert.deepEqual(await routeOfGame(owned, directory, routes), { kind: "route", pool: "p2", destination: { wsPath: "/gs/p/p2" } }, "an owned game never needs the routing");
  });
});

/* ==================================================================
    §3 THE COMPOSITION: A PRIMARY, A NON-PRIMARY TASK, AND A FLIP
   ================================================================== */
const LEDGER_ARN = "arn:aws:dynamodb:us-east-1:210987654321:table/gs-l61-ledger";
const docFor = (pool: string) =>
  parseAwsRuntimeConfig({
    format: AWS_RUNTIME_CONFIG_FORMAT_V2,
    environment: "local",
    region: "us-east-1",
    pool,
    generation: 1,
    game_table: "gs-l61-game-g1",
    identity_table: "gs-l61-identity",
    ledger_table_arn: LEDGER_ARN,
    escrow: null,
    routes: { p0: { ws_path: "/gs/p/p0" }, p1: { ws_path: "/gs/p/p1" } },
  });

interface Started {
  readonly runtime: AwsRuntime;
  readonly exits: number[];
}

async function start(t: { game: string; identity: string; ledger: string }, pool: string, task: string): Promise<Started> {
  const exits: number[] = [];
  const app = await freshClient();
  const runtime = await startAwsRuntime({
    config: docFor(pool),
    escrowConfig: null,
    server: { mode: "production", allowedOrigins: ["https://play.example"], trustedProxyHops: 1 },
    build: "l6-1-ddb",
    port: 0,
    bindHost: "127.0.0.1",
    moneySwitch: undefined,
    task,
    substrate: realAwsSubstrate({ config: docFor(pool), clients: { app, ledger: app }, tables: t, timing: { maxResends: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined } }),
    ops: createMemoryOpsRecorder(),
    now: () => Date.now(),
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    exit: (code) => exits.push(code),
    timing: { sweepEveryMs: 3_600_000, sweepRetryMs: 20, relayerRetryMs: 3_600_000, failFastDelayMs: 5, drainEscrowMs: 1_000, drainOwnershipMs: 1_000, drainChainFactsMs: 500, drainIdentityMs: 2_000, routingWatchMs: 3_600_000 },
  });
  return { runtime, exits };
}

async function until(predicate: () => boolean, label: string, ms = 8_000): Promise<void> {
  const deadlineAt = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadlineAt) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function portOf(runtime: AwsRuntime): Promise<number> {
  if (!runtime.http.listening) await new Promise((resolve) => runtime.http.once("listening", resolve));
  const address = runtime.http.address();
  return typeof address === "object" && address !== null ? address.port : 0;
}

describe("§3 a primary and a non-primary task on the same tables; the routing flips", () => {
  test("the non-primary task authenticates a real browser read-only and routes its game to the primary's path; the flip restarts both into their new roles", async () => {
    const game = await tables.create("l61-game");
    const identity = await tables.create("l61-identity");
    const ledger = await tables.create("l61-ledger");
    await admin.send(new PutItemCommand({ TableName: ledger, Item: { ...LEDGER_KEYS.appgen(), schema: N(1), current_generation: N(1) } }), { abortSignal: deadline() });
    /* LIVE-6 L6-4 (integrated by L6-2): the first deployment's bootstrap marks the first game table with its generation. */
    const marker = bootstrapGenerationMarker({ generation: 1, gameTable: docFor("p0").gameTable, by: "l5-8-bootstrap", now: 1 });
    await admin.send(new PutItemCommand({ TableName: game, Item: generationMarkerItem(marker), ConditionExpression: "attribute_not_exists(pk)" }), { abortSignal: deadline() });
    assert.equal((await setPrimaryPool(admin, game, { pool: "p0", expectedVersion: null, by: "pipeline", now: 1 })).kind, "set");
    const t = { game, identity, ledger };

    const a = await start(t, "p0", "t-a");
    let b: Started | null = null;
    const later: Started[] = [];
    try {
      assert.equal(a.runtime.role, "primary");
      const primaryIdentity = a.runtime.identity as IdentityService;
      /* A browser with an account made on the primary (the identity writer): the create's FRESH session is its cookie. */
      const boot = await primaryIdentity.bootstrap({ kind: "none" }, false, Date.now());
      const created = await createAccountWith(primaryIdentity, readOf((boot as { setCookie: string }).setCookie), { username: "ann", password: PASSWORD, displayName: "Ann", wallet: keplrAccount("l6-1-dynamo/primary-ann") }, Date.now());
      assert.equal(created.kind, "ok", JSON.stringify(created));
      const cookie = (created as { setCookie: string }).setCookie.split(";")[0];
      const read = readSessionCookie(cookie);
      await primaryIdentity.flush(Date.now());
      const principalId = (primaryIdentity.peekSession(read.kind === "session" ? read.sessionId : "") as Session).principal_id;
      /* A game the primary created (its HEAD names p0), in which Ann holds a seat. */
      const base = seededRecord([ALICE, BOB]);
      const record = { ...base, seats: base.seats.map((seat, at) => (at === 0 ? { ...seat, principal_id: principalId } : seat)) } as GameRecord;
      assert.equal((await a.runtime.server!.records.put(record, null)).kind, "committed");
      assert.equal((await readHead(admin, game, record.game_id))?.owner_pool, "p0");
      await a.runtime.server!.lifecycle.loadGame(record.game_id); // resident on the primary (a player's table)

      b = await start(t, "p1", "t-b");
      assert.equal(b.runtime.role, "non-primary");
      assert.equal((await readIdentityRole(admin, identity))?.pool, "p0", "the non-primary task took no identity-writer role");
      const port = await portOf(b.runtime);
      const beforeGame = await tableBytes(game);
      const beforeIdentity = await tableBytes(identity);
      const frames: Array<Record<string, unknown>> = [];
      const socket = new WebSocket(`ws://127.0.0.1:${port}/gs/p/p1?${clientAnnouncementQuery(1, [11], "tab")}`, { origin: "https://play.example", headers: { Cookie: cookie, "X-Forwarded-For": "203.0.113.20" } });
      const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
      socket.on("message", (raw) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("unexpected-response", (_request, response) => reject(new Error(`upgrade refused ${response.statusCode}`)));
      });
      socket.send(JSON.stringify({ kind: "hello", gameId: record.game_id, build: "tab", baseIndex: -1 }));
      assert.equal(await closed, CLIENT_ANSWER_CLOSE_CODE);
      assert.deepEqual(frames.map((frame) => [frame.kind, frame.wsPath, frame.gameId]), [["route", "/gs/p/p0", record.game_id]]);
      assert.equal(await tableBytes(game), beforeGame, "the game table is unchanged by the non-primary task (no claim, no write)");
      assert.equal(await tableBytes(identity), beforeIdentity, "the identity table is unchanged by the non-primary task");

      /* THE FLIP: the pipeline names p1 primary. Each task reads it and restarts into its new role (exit 5). */
      const routing = await readRouting(admin, game);
      assert.equal((await setPrimaryPool(admin, game, { pool: "p1", expectedVersion: routing?.routing_version ?? null, by: "pipeline", now: 2 })).kind, "set");
      await b.runtime.checkRouting();
      await a.runtime.checkRouting();
      await until(() => a.exits.length > 0 && (b as Started).exits.length > 0, "both tasks' exits");
      assert.deepEqual([a.exits, b.exits], [[EXIT_ROLE_CHANGED], [EXIT_ROLE_CHANGED]]);
      assert.ok(a.runtime.shutdownSteps.includes("identity-settled"), "the demoted primary drained its identity before it exited");
      assert.equal((await readHead(admin, game, record.game_id))?.owner_pool, "#none", "the demoted primary gave its resident no-money game back");
      /* The restarts: p1's task is the primary now -- the identity-writer role moved to it through the startup order. */
      const c = await start(t, "p1", "t-c");
      later.push(c);
      assert.equal(c.runtime.role, "primary");
      const role = await readIdentityRole(admin, identity);
      assert.deepEqual([role?.epoch, role?.pool, role?.task], [2, "p1", "t-c"]);
      const d = await start(t, "p0", "t-d");
      later.push(d);
      assert.equal(d.runtime.role, "non-primary");
      assert.equal((await readIdentityRole(admin, identity))?.task, "t-c", "the restarted p0 task took nothing");
      /* The restarted primary serves Ann from the durable records the old writer committed, and claims the released game. */
      assert.equal((c.runtime.identity as IdentityService).authenticate(read, Date.now()).kind, "ok");
      await c.runtime.server!.lifecycle.loadGame(record.game_id);
      assert.equal((await readHead(admin, game, record.game_id))?.owner_pool, "p1", "the new primary serves the game the old one released");
    } finally {
      if (a.exits.length === 0) await a.runtime.shutdown();
      if (b !== null && b.exits.length === 0) await b.runtime.shutdown();
      for (const started of later) await started.runtime.shutdown();
    }
  });
});
