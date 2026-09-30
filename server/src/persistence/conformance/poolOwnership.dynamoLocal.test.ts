// server/src/persistence/conformance/poolOwnership.dynamoLocal.test.ts
//
// ==================================================================
//  LIVE-5 L5-3: THE POOL WRITER, THE ROUTING, THE ROLE TAKEOVER AND PER-GAME OWNERSHIP -- ON DYNAMODB LOCAL
// ==================================================================
//
// Runs ONLY against a DynamoDB Local named by GS_DYNAMODB_LOCAL_ENDPOINT (`npm run test:dynamodb-local`), like the rest
// of LIVE-5's DynamoDB suites; without one it FAILS with instructions.
//
// What L5-3 adds on L5-2's primitives, stated against the real table:
//   §1 the pool writer: a takeover fences the older task, whose self-check proves the loss ONCE; a failed or damaged read
//      proves nothing (unknown: side effects wait, readiness lapses, never "lost"); the side-effect gate catches a
//      takeover that happened after the task last looked; the adopted generation is watched.
//   §2 the routing and the identity-writer role: only the primary pool's CURRENT task takes the role, decided inside the
//      takeover's own transaction -- a routing flip or a pool takeover between the task's look and its takeover refuses
//      it; a newer primary taking the role makes the old one lost.
//   §3 per-game ownership: claim before load; route; release; THE RACE the brief names -- a takeover between an
//      application's ownership observation and its authoritative write is refused INSIDE the write, nothing lands, and
//      the stale task learns it is lost -- in both orders (the write before and after the new task's claim); a pool
//      fence reported by a store is proof of loss; claims and releases keep their order.
//   §4 the money claim sweep.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DeleteItemCommand, PutItemCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createDynamoDbClient, deadline, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../../aws/awsClients";
import { headKey, poolKey, readHead, NO_OWNER } from "../../aws/game/gameTable";
import { claimGame, releaseGame, takeOverPool } from "../../aws/game/ownership";
import { parseRouting, readRouting, ROUTING_KEY, RoutingUnreadableError, setPrimaryPool } from "../../aws/game/routing";
import { createDynamoLogStore } from "../../aws/game/dynamoLogStore";
import { createDynamoRecordStore } from "../../aws/game/dynamoRecordStore";
import { createDynamoFinancialStore } from "../../aws/game/dynamoFinancialStore";
import type { ResendTiming } from "../../aws/game/transact";
import { readIdentityRole } from "../../aws/identity/dynamoIdentityStore";
import { LEDGER_KEYS } from "../../aws/ledger/dynamoSigningLedger";
import { PoolTakeoverLostError, PoolWriter, PoolWriterNotCurrentError } from "../../aws/ownership/poolWriter";
import { generationProbe, IDENTITY_WRITER_ROLE, takeIdentityWriterRole } from "../../aws/ownership/roles";
import { createPoolGameOwnership } from "../../aws/ownership/poolGameOwnership";
import { transitionFinancial } from "../../escrow/moneyLifecycle";
import { fenceScopeOf } from "../storeResult";
import { GameOwnershipLostError, GameRoutedError } from "../../rooms/gameOwnership";
import { ConformanceTables, installFaults, newRunId, requireLocal } from "./dynamoLocal";
import { FaultScript, gate } from "./faults";
import { entries, financial, gameId, gameRecord } from "./fixtures";

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
const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number): AttributeValue => ({ N: String(value) });

/** Resends are real; their pacing is not (no test waits on a clock). */
const TIMING: Partial<ResendTiming> = { maxResends: 2, windowMs: 60_000, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined };

after(async () => {
  for (const client of clients) client.destroy();
  await tables.dropAll();
  assert.deepEqual(tables.live, [], "every table this run made was dropped");
  admin.destroy();
});

/** A client of its own (faults installed on it touch nobody else). */
async function freshClient(script?: FaultScript): Promise<DynamoDBClient> {
  const client = createDynamoDbClient(TARGET);
  await requireLocal(client);
  if (script !== undefined) installFaults(client, script);
  clients.push(client);
  return client;
}

function manualClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

interface Task {
  readonly writer: PoolWriter;
  readonly lost: string[];
  readonly client: DynamoDBClient;
}

async function take(table: string, pool: string, task: string, over: { clock?: ReturnType<typeof manualClock>; script?: FaultScript; freshForMs?: number; readyForMs?: number } = {}): Promise<Task> {
  const client = await freshClient(over.script);
  const lost: string[] = [];
  const clock = over.clock ?? manualClock();
  const writer = await PoolWriter.take({
    client,
    table,
    pool,
    task,
    now: clock.now,
    onLost: (reason) => lost.push(reason),
    ...(over.freshForMs !== undefined ? { freshForMs: over.freshForMs } : {}),
    ...(over.readyForMs !== undefined ? { readyForMs: over.readyForMs } : {}),
  });
  return { writer, lost, client };
}

const put = (table: string, item: Record<string, AttributeValue>) => admin.send(new PutItemCommand({ TableName: table, Item: item }), { abortSignal: deadline() });
const remove = (table: string, key: Record<string, AttributeValue>) => admin.send(new DeleteItemCommand({ TableName: table, Key: key }), { abortSignal: deadline() });

/* ==================================================================
    §1 THE POOL WRITER
   ================================================================== */
describe("§1 the pool writer", () => {
  test("a takeover fences the older task: its self-check proves the loss exactly once, and every gate refuses from then on; the newer task is current", async () => {
    const table = await tables.create("pw-takeover");
    const a = await take(table, "pool-a", "task-1");
    assert.equal(a.writer.epoch, 1);
    assert.deepEqual(await a.writer.check(), { kind: "current" });
    const b = await take(table, "pool-a", "task-2");
    assert.equal(b.writer.epoch, 2);
    const verdict = await a.writer.check();
    assert.equal(verdict.kind, "lost");
    assert.equal(a.lost.length, 1, "onLost once");
    await a.writer.check();
    assert.equal(a.lost.length, 1, "and never again");
    assert.throws(() => a.writer.assertCurrent(), PoolWriterNotCurrentError);
    await assert.rejects(a.writer.beforeSideEffect(), (error: PoolWriterNotCurrentError) => error.lost === true);
    assert.equal(a.writer.readiness().ready, false);
    assert.deepEqual(await b.writer.check(), { kind: "current" });
    assert.deepEqual(b.lost, []);
  });

  test("two tasks taking one pool at the same moment: afterwards exactly one of them is current", async () => {
    const table = await tables.create("pw-race");
    for (let round = 0; round < 5; round += 1) {
      const pool = `pool-r${round}`;
      const settled = await Promise.allSettled([take(table, pool, `x-${round}`), take(table, pool, `y-${round}`)]);
      const writers = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
      for (const s of settled) if (s.status === "rejected") assert.ok(s.reason instanceof PoolTakeoverLostError, String(s.reason));
      const verdicts = await Promise.all(writers.map((w) => w.writer.check()));
      assert.equal(verdicts.filter((v) => v.kind === "current").length, 1, `round ${round}: exactly one current (${JSON.stringify(verdicts)})`);
    }
  });

  test("a read that fails, or a pool item this build cannot read, is UNKNOWN: never lost, never current -- side effects wait, readiness lapses; a good check restores both", async () => {
    const table = await tables.create("pw-unknown");
    const clock = manualClock();
    const script = new FaultScript();
    const a = await take(table, "pool-a", "task-1", { clock, script, freshForMs: 5_000, readyForMs: 25_000 });
    clock.advance(6_000);
    script.add({ op: "GetItemCommand", action: { kind: "fail" } });
    assert.equal((await a.writer.check()).kind, "unknown");
    assert.deepEqual(a.lost, [], "a throttled read is not a takeover");
    script.add({ op: "GetItemCommand", action: { kind: "fail" } });
    await assert.rejects(a.writer.beforeSideEffect(), (error: PoolWriterNotCurrentError) => error.lost === false, "the side effect waits: its own check could not tell");
    /* Damage: the epoch stored as text. Not a takeover; not current either. */
    await put(table, { ...poolKey("pool-a"), writer_epoch: S("1"), writer_task: S("task-1"), taken_at: N(0) });
    clock.advance(30_000);
    assert.equal((await a.writer.check()).kind, "unknown");
    assert.deepEqual(a.lost, []);
    assert.equal(a.writer.readiness().ready, false, "no good check for 25 s: not ready");
    await assert.rejects(a.writer.beforeSideEffect(), (error: PoolWriterNotCurrentError) => error.lost === false);
    /* Repaired: current again, ready again, side effects allowed. */
    await put(table, { ...poolKey("pool-a"), writer_epoch: N(1), writer_task: S("task-1"), taken_at: N(0) });
    assert.deepEqual(await a.writer.check(), { kind: "current" });
    assert.equal(a.writer.readiness().ready, true);
    await a.writer.beforeSideEffect();
  });

  test("the pool item gone (a restored or replaced table) is LOST", async () => {
    const table = await tables.create("pw-gone");
    const a = await take(table, "pool-a", "task-1");
    await remove(table, poolKey("pool-a"));
    assert.equal((await a.writer.check()).kind, "lost");
    assert.equal(a.lost.length, 1);
  });

  test("the side-effect gate: a takeover AFTER the task last looked is caught once the last good check is older than the freshness window -- and a check that started before the call does not vouch for it", async () => {
    const table = await tables.create("pw-gate");
    const clock = manualClock();
    const script = new FaultScript();
    const a = await take(table, "pool-a", "task-1", { clock, script, freshForMs: 5_000 });
    const readsAtTakeover = script.count("GetItemCommand");
    await a.writer.beforeSideEffect(); // fresh from the takeover itself: no read needed
    assert.equal(script.count("GetItemCommand"), readsAtTakeover);
    /* The observation: a good check now. Then a newer task takes the pool. */
    assert.deepEqual(await a.writer.check(), { kind: "current" });
    await take(table, "pool-a", "task-2");
    /* Inside the window the gate does not read (the documented stale window: the fences, not this gate, stop writes). */
    clock.advance(1_000);
    await a.writer.beforeSideEffect();
    /* Past it, the gate reads -- and refuses: the task is lost. */
    clock.advance(5_000);
    await assert.rejects(a.writer.beforeSideEffect(), (error: PoolWriterNotCurrentError) => error.lost === true);
    assert.equal(a.lost.length, 1);

    /* A check IN FLIGHT when the gate is asked, started before the gate: its answer is too old to vouch; a second
       check, started after the call, decides. */
    const table2 = await tables.create("pw-gate2");
    const clock2 = manualClock();
    const script2 = new FaultScript();
    const c = await take(table2, "pool-c", "task-c", { clock: clock2, script: script2, freshForMs: 5_000 });
    const readsBefore = script2.count("GetItemCommand");
    const held = gate();
    script2.add({ op: "GetItemCommand", action: { kind: "stall", gate: held } });
    const early = c.writer.check(); // started at t0
    await held.reached;
    clock2.advance(6_000);
    const gated = c.writer.beforeSideEffect(); // joins the stalled check
    held.release();
    assert.deepEqual(await early, { kind: "current" });
    await gated;
    assert.equal(script2.count("GetItemCommand") - readsBefore, 2, "the gate ran its own, later check");
  });

  test("the adopted generation is watched: a restore adopted elsewhere makes the task lost; a damaged APPGEN proves nothing", async () => {
    const table = await tables.create("pw-gen");
    const ledger = await tables.create("pw-gen-ledger");
    await put(ledger, { ...LEDGER_KEYS.appgen(), schema: N(1), current_generation: N(1) });
    const a = await take(table, "pool-a", "task-1");
    a.writer.watchGeneration(generationProbe(admin, ledger, 1));
    assert.deepEqual(await a.writer.check(), { kind: "current" });
    await put(ledger, { ...LEDGER_KEYS.appgen(), schema: N(9), current_generation: N(1) });
    assert.equal((await a.writer.check()).kind, "unknown", "a newer or damaged APPGEN is not read as another generation");
    await put(ledger, { ...LEDGER_KEYS.appgen(), schema: N(1), current_generation: N(2) });
    const verdict = await a.writer.check();
    assert.equal(verdict.kind, "lost");
    assert.match(a.lost[0] ?? "", /generation/);
  });
});

/* ==================================================================
    §2 THE ROUTING AND THE IDENTITY-WRITER ROLE
   ================================================================== */
describe("§2 SYSTEM/ROUTING and the identity-writer role", () => {
  test("the routing: created once, moved by compare-and-swap only, never to an operator run; a lost answer is settled by its claim; an item this build cannot read is refused", async () => {
    const table = await tables.create("routing");
    assert.equal(await readRouting(admin, table), null);
    const first = await setPrimaryPool(admin, table, { pool: "pool-a", expectedVersion: null, by: "pipeline-1", now: 5 });
    assert.equal(first.kind, "set");
    assert.equal((await readRouting(admin, table))?.primary_pool, "pool-a");
    assert.equal((await setPrimaryPool(admin, table, { pool: "pool-b", expectedVersion: null, by: "pipeline-2", now: 6 })).kind, "conflict", "created once");
    assert.equal((await setPrimaryPool(admin, table, { pool: "pool-b", expectedVersion: 7, by: "pipeline-2", now: 6 })).kind, "conflict", "a stale version moves nothing");
    await assert.rejects(setPrimaryPool(admin, table, { pool: "op:run-1", expectedVersion: 1, by: "operator", now: 7 }), /operator run/);
    const lossy = new FaultScript([{ op: "PutItemCommand", action: { kind: "lose-answer" } }]);
    const client = await freshClient(lossy);
    const moved = await setPrimaryPool(client, table, { pool: "pool-b", expectedVersion: 1, by: "pipeline-2", now: 8 });
    assert.equal(moved.kind, "set", "the lost answer is settled by the item's claim");
    assert.equal(moved.kind === "set" ? moved.routing.routing_version : 0, 2);
    await put(table, { ...ROUTING_KEY, fmt: N(2), primary_pool: S("pool-b"), routing_version: N(3), updated_at: N(0), updated_by: S("x"), claim: S("y") });
    await assert.rejects(readRouting(admin, table), RoutingUnreadableError);
    await assert.rejects(setPrimaryPool(admin, table, { pool: "pool-a", expectedVersion: 3, by: "pipeline-3", now: 9 }), RoutingUnreadableError, "never overwritten, never read as no primary");
    assert.throws(() => parseRouting({ ...ROUTING_KEY, fmt: N(1), primary_pool: S("pool-b"), routing_version: N(3), updated_at: N(0), updated_by: S("x"), claim: S("y"), extra: S("z") }), RoutingUnreadableError);
  });

  async function roleTables(label: string) {
    const game = await tables.create(`${label}-game`);
    const identity = await tables.create(`${label}-identity`);
    return { game, identity };
  }

  test("only the primary pool's current task takes the identity-writer role; the role is then watched by the task's self-check", async () => {
    const { game, identity } = await roleTables("role");
    const a = await take(game, "pool-a", "task-a1");
    const opts = { now: () => 1_000, sleep: async () => undefined };
    assert.deepEqual(await takeIdentityWriterRole(a.writer, { client: a.client, table: identity }, opts), { kind: "not-primary", primary: null }, "no routing: no role");
    await setPrimaryPool(admin, game, { pool: "pool-b", expectedVersion: null, by: "pipeline", now: 1 });
    assert.deepEqual(await takeIdentityWriterRole(a.writer, { client: a.client, table: identity }, opts), { kind: "not-primary", primary: "pool-b" });
    assert.equal(await readIdentityRole(admin, identity), null, "nothing was taken");
    await setPrimaryPool(admin, game, { pool: "pool-a", expectedVersion: 1, by: "pipeline", now: 2 });
    assert.deepEqual(await takeIdentityWriterRole(a.writer, { client: a.client, table: identity }, opts), { kind: "taken", epoch: 1 });
    const role = await readIdentityRole(admin, identity);
    assert.deepEqual([role?.epoch, role?.task, role?.pool], [1, "task-a1", "pool-a"]);
    assert.deepEqual(await a.writer.check(), { kind: "current" }, "the role probe holds");
    void IDENTITY_WRITER_ROLE;
  });

  test("RACE: the routing flips between the task's look and its takeover -- refused INSIDE the takeover's transaction: not primary, the role untouched", async () => {
    const { game, identity } = await roleTables("role-flip");
    await setPrimaryPool(admin, game, { pool: "pool-a", expectedVersion: null, by: "pipeline", now: 1 });
    const script = new FaultScript();
    const a = await take(game, "pool-a", "task-a1", { script });
    const held = gate();
    script.add({ op: "TransactWriteItemsCommand", action: { kind: "stall", gate: held } });
    const taking = takeIdentityWriterRole(a.writer, { client: a.client, table: identity }, { now: () => 1_000, sleep: async () => undefined, maxAttempts: 1 });
    await held.reached; // the task looked (primary: pool-a) and is about to take the role
    await setPrimaryPool(admin, game, { pool: "pool-b", expectedVersion: 1, by: "pipeline", now: 2 });
    held.release();
    assert.deepEqual(await taking, { kind: "not-primary", primary: "pool-b" });
    assert.equal(await readIdentityRole(admin, identity), null, "the role was never taken");
    assert.deepEqual(a.lost, [], "a routing flip is not a pool loss");
  });

  test("RACE: a newer task takes the pool between the old task's look and its role takeover -- refused INSIDE the write; the old task is lost; the role untouched", async () => {
    const { game, identity } = await roleTables("role-pool");
    await setPrimaryPool(admin, game, { pool: "pool-a", expectedVersion: null, by: "pipeline", now: 1 });
    const script = new FaultScript();
    const a = await take(game, "pool-a", "task-a1", { script });
    const held = gate();
    script.add({ op: "TransactWriteItemsCommand", action: { kind: "stall", gate: held } });
    const taking = takeIdentityWriterRole(a.writer, { client: a.client, table: identity }, { now: () => 1_000, sleep: async () => undefined, maxAttempts: 1 });
    await held.reached;
    const b = await take(game, "pool-a", "task-a2");
    held.release();
    await assert.rejects(taking);
    assert.equal(await readIdentityRole(admin, identity), null, "the stale task took nothing");
    assert.equal(a.lost.length, 1, "and it knows it is lost");
    assert.deepEqual(await takeIdentityWriterRole(b.writer, { client: b.client, table: identity }, { now: () => 2_000, sleep: async () => undefined }), { kind: "taken", epoch: 1 }, "the current task takes it");
  });

  test("a takeover whose outcome was not known -- it LANDED, its answer and its read-back were lost, then the routing flipped -- is settled from the role item: taken and watched, never answered not-primary (review L1)", async () => {
    const { game, identity } = await roleTables("role-unknown");
    await setPrimaryPool(admin, game, { pool: "pool-a", expectedVersion: null, by: "pipeline", now: 1 });
    const a = await take(game, "pool-a", "task-a1");
    const held = gate();
    const script = new FaultScript([
      { op: "TransactWriteItemsCommand", nth: 1, action: { kind: "lose-answer" }, label: "the takeover lands; its answer is lost" },
      { op: "TransactWriteItemsCommand", nth: 2, action: { kind: "fail" }, label: "its resend is throttled" },
      { op: "GetItemCommand", nth: 2, action: { kind: "fail" }, label: "the read-back fails" },
      { op: "TransactWriteItemsCommand", nth: 3, action: { kind: "stall", gate: held }, label: "the second attempt waits" },
    ]);
    const identityClient = await freshClient(script);
    const taking = takeIdentityWriterRole(a.writer, { client: identityClient, table: identity }, { now: () => 1_000, sleep: async () => undefined });
    await held.reached;
    await setPrimaryPool(admin, game, { pool: "pool-b", expectedVersion: 1, by: "pipeline", now: 2 });
    held.release();
    assert.deepEqual(await taking, { kind: "taken", epoch: 1 }, "the role item names this task: it is this task's");
    assert.deepEqual(script.unfired(), []);
    const role = await readIdentityRole(admin, identity);
    assert.deepEqual([role?.epoch, role?.task], [1, "task-a1"]);
    assert.deepEqual(await a.writer.check(), { kind: "current" }, "and it is watched");
    const b = await take(game, "pool-b", "task-b1");
    assert.equal((await takeIdentityWriterRole(b.writer, { client: b.client, table: identity }, { now: () => 2_000 })).kind, "taken");
    assert.equal((await a.writer.check()).kind, "lost", "so the demotion is noticed");
  });

  test("a flip, then the new primary takes the role: the old primary's self-check proves its loss (a demoted writer never keeps serving)", async () => {
    const { game, identity } = await roleTables("role-demote");
    await setPrimaryPool(admin, game, { pool: "pool-a", expectedVersion: null, by: "pipeline", now: 1 });
    const a = await take(game, "pool-a", "task-a1");
    assert.equal((await takeIdentityWriterRole(a.writer, { client: a.client, table: identity }, { now: () => 1_000 })).kind, "taken");
    await setPrimaryPool(admin, game, { pool: "pool-b", expectedVersion: 1, by: "pipeline", now: 2 });
    assert.deepEqual(await a.writer.check(), { kind: "current" }, "the flip alone moves no role: the old primary holds it until the new one takes it");
    const b = await take(game, "pool-b", "task-b1");
    assert.deepEqual(await takeIdentityWriterRole(b.writer, { client: b.client, table: identity }, { now: () => 2_000 }), { kind: "taken", epoch: 2 });
    const verdict = await a.writer.check();
    assert.equal(verdict.kind, "lost");
    assert.match(a.lost[0] ?? "", /identity-writer/);
  });
});

/* ==================================================================
    §3 PER-GAME OWNERSHIP
   ================================================================== */
describe("§3 per-game ownership", () => {
  /** A table whose game `n` exists (its record's creation made its HEAD, owned by `task`). */
  async function withGame(label: string, n: number) {
    const table = await tables.create(label);
    const a = await take(table, "pool-a", "task-a1");
    const records = createDynamoRecordStore({ client: a.client, table, fence: a.writer.fence, timing: TIMING });
    assert.equal((await records.put(gameRecord(n), null)).kind, "committed");
    return { table, a, g: gameId(n) };
  }

  test("claim: `absent` for no HEAD; `claimed` (onClaimed runs before the claim resolves); another pool's game is ROUTED, never taken; a released game can be claimed by another pool", async () => {
    const { table, a, g } = await withGame("own-claim", 1);
    const refreshed: string[] = [];
    const ownA = createPoolGameOwnership({ client: a.client, table, writer: a.writer, timing: TIMING, onClaimed: async (id) => void refreshed.push(id) });
    assert.deepEqual(await ownA.claim(gameId(99)), { kind: "absent" });
    assert.deepEqual(await ownA.claim(g), { kind: "claimed" });
    assert.deepEqual(refreshed, [g]);
    const b = await take(table, "pool-b", "task-b1");
    const ownB = createPoolGameOwnership({ client: b.client, table, writer: b.writer, timing: TIMING });
    await assert.rejects(ownB.claim(g), (error: GameRoutedError) => error instanceof GameRoutedError && error.ownerPool === "pool-a");
    assert.deepEqual(b.lost, [], "being routed is not being lost");
    ownA.release(g);
    await ownA.settled();
    assert.equal((await readHead(admin, table, g))?.owner_pool, NO_OWNER);
    assert.deepEqual(await ownB.claim(g), { kind: "claimed" });
    await assert.rejects(ownA.claim(g), GameRoutedError, "and now pool-a is routed to pool-b");
  });

  test("THE RACE: a newer task takes the pool and claims the game between the old task's observation and its write -- refused INSIDE the write, nothing lands, the old task learns it is lost", async () => {
    const { table, a, g } = await withGame("own-race", 2);
    const ownA = createPoolGameOwnership({ client: a.client, table, writer: a.writer, timing: TIMING });
    assert.deepEqual(await ownA.claim(g), { kind: "claimed" }); // the observation: "this game is mine"
    const logA = createDynamoLogStore({ client: a.client, table, fence: a.writer.fence, timing: TIMING });
    assert.equal((await logA.appendBatch(g, entries(0, 1))).kind, "committed");

    const b = await take(table, "pool-a", "task-a2");
    const ownB = createPoolGameOwnership({ client: b.client, table, writer: b.writer, timing: TIMING });
    assert.deepEqual(await ownB.claim(g), { kind: "claimed" });

    const refused = await logA.appendBatch(g, entries(1, 1, "stale"));
    assert.equal(refused.kind, "definite", "the table refused it inside the write");
    assert.equal(fenceScopeOf(refused), "game");
    ownA.onFenced(g, "game", refused.kind === "definite" ? refused.detail : "");
    assert.equal((await a.writer.check()).kind, "lost", "the old task's check finds the pool moved");
    assert.equal(a.lost.length, 1);

    const logB = createDynamoLogStore({ client: b.client, table, fence: b.writer.fence, timing: TIMING });
    assert.deepEqual((await logB.loadLog(g)).map((e) => e.id), ["s0-0"], "nothing of the stale write landed");
    assert.equal((await logB.appendBatch(g, entries(1, 1, "fresh"))).kind, "committed");
    await assert.rejects(ownA.claim(g), GameOwnershipLostError, "a lost task claims nothing");
  });

  test("THE RACE, other order: the old task's write lands BEFORE the new task's claim -- the new task's load (after its claim) sees it; every later write of the old task is refused", async () => {
    const { table, a, g } = await withGame("own-race2", 3);
    const ownA = createPoolGameOwnership({ client: a.client, table, writer: a.writer, timing: TIMING });
    await ownA.claim(g);
    const logA = createDynamoLogStore({ client: a.client, table, fence: a.writer.fence, timing: TIMING });
    const b = await take(table, "pool-a", "task-a2"); // the pool is taken; the GAME is not claimed yet
    assert.equal((await logA.appendBatch(g, entries(0, 1))).kind, "committed", "until the new task claims it, the old one is still the game's only writer");
    const ownB = createPoolGameOwnership({ client: b.client, table, writer: b.writer, timing: TIMING });
    await ownB.claim(g);
    const logB = createDynamoLogStore({ client: b.client, table, fence: b.writer.fence, timing: TIMING });
    assert.deepEqual((await logB.loadLog(g)).map((e) => e.id), ["s0-0"], "claim, then load: the landed write is there");
    assert.equal(fenceScopeOf(await logA.appendBatch(g, entries(1, 1, "stale"))), "game");
    assert.deepEqual((await logB.loadLog(g)).map((e) => e.id), ["s0-0"]);
  });

  test("a claim by a stale task is refused by the pool fence (LOST); a game already claimed by a newer task of the same pool makes the claimer LOST too", async () => {
    const { table, a, g } = await withGame("own-stale", 4);
    const ownA = createPoolGameOwnership({ client: a.client, table, writer: a.writer, timing: TIMING });
    await take(table, "pool-a", "task-a2");
    await assert.rejects(ownA.claim(g), GameOwnershipLostError);
    assert.equal(a.lost.length, 1);

    /* The second shape: the claimer's pool epoch is still the pool's newest in ITS view -- but a newer epoch claimed. */
    const table2 = await tables.create("own-stale2");
    const x = await take(table2, "pool-x", "task-x1");
    const records = createDynamoRecordStore({ client: x.client, table: table2, fence: x.writer.fence, timing: TIMING });
    assert.equal((await records.put(gameRecord(5), null)).kind, "committed");
    const y = await take(table2, "pool-x", "task-x2");
    assert.equal((await claimGame(admin, table2, gameId(5), y.writer.fence)).kind, "claimed");
    const ownX = createPoolGameOwnership({ client: x.client, table: table2, writer: x.writer, timing: TIMING });
    await assert.rejects(ownX.claim(gameId(5)), GameOwnershipLostError);
    assert.equal(x.lost.length, 1);
  });

  test("an operator run owns the game: the pool is ROUTED (not lost), its own write to the game is refused by the GAME fence, and its self-check stays current", async () => {
    const { table, a, g } = await withGame("own-op", 6);
    const ownA = createPoolGameOwnership({ client: a.client, table, writer: a.writer, timing: TIMING });
    await ownA.claim(g);
    const logA = createDynamoLogStore({ client: a.client, table, fence: a.writer.fence, timing: TIMING });
    /* The operator takes it (here: a release, then the operator run's claim -- `--take` is L6-3's). */
    assert.equal(await releaseGame(admin, table, g, a.writer.fence), true);
    const op = await takeOverPool(admin, table, "op:run-1", "operator", 1);
    assert.equal(op.kind, "taken");
    assert.equal((await claimGame(admin, table, g, { pool: "op:run-1", epoch: 1, task: "operator" })).kind, "claimed");
    const refused = await logA.appendBatch(g, entries(0, 1));
    assert.equal(fenceScopeOf(refused), "game");
    ownA.onFenced(g, "game", "");
    assert.deepEqual(await a.writer.check(), { kind: "current" }, "an operator's claim of one game is not a pool loss");
    await assert.rejects(ownA.claim(g), (error: GameRoutedError) => error instanceof GameRoutedError && error.ownerPool === "op:run-1");
    assert.deepEqual(a.lost, []);
  });

  test("a POOL fence reported by a store is proof of loss (no read needed): a stale task's record creation", async () => {
    const table = await tables.create("own-poolfence");
    const a = await take(table, "pool-a", "task-a1");
    const ownA = createPoolGameOwnership({ client: a.client, table, writer: a.writer, timing: TIMING });
    await take(table, "pool-a", "task-a2");
    const records = createDynamoRecordStore({ client: a.client, table, fence: a.writer.fence, timing: TIMING });
    const refused = await records.put(gameRecord(7), null);
    assert.equal(fenceScopeOf(refused), "pool", JSON.stringify(refused));
    ownA.onFenced(gameId(7), "pool", refused.kind === "definite" ? refused.detail : "");
    assert.equal(a.lost.length, 1);
    assert.equal(await readHead(admin, table, gameId(7)), null, "a stale task created nothing");
  });

  test("claims and releases of one game keep the order they were asked in", async () => {
    const { table, a, g } = await withGame("own-order", 8);
    const ownA = createPoolGameOwnership({ client: a.client, table, writer: a.writer, timing: TIMING });
    await ownA.claim(g);
    ownA.release(g);
    const claimed = ownA.claim(g); // asked after the release: lands after it
    assert.deepEqual(await claimed, { kind: "claimed" });
    await ownA.settled();
    assert.equal((await readHead(admin, table, g))?.owner_pool, "pool-a", "release, then claim: owned");
    void ownA.claim(g);
    ownA.release(g);
    await ownA.settled();
    assert.equal((await readHead(admin, table, g))?.owner_pool, NO_OWNER, "claim, then release: released");
  });
});

/* ==================================================================
    §4 THE MONEY CLAIM SWEEP
   ================================================================== */
describe("§4 the money claim sweep", () => {
  test("every open money game nobody owns and this pool continues is claimed and handed on; another pool's is left; one not continued is skipped; a closed one is never visited; a second pass finds them owned", async () => {
    const table = await tables.create("sweep");
    const old = await take(table, "pool-a", "task-a1");
    const fin = createDynamoFinancialStore({ client: old.client, table, fence: old.writer.fence, timing: TIMING });
    for (const n of [11, 12, 13, 14, 15]) assert.equal((await fin.create(financial(n))).outcome.kind, "committed");
    /* 11: released; 12: released, then claimed by pool-b; 13: released, not continued here; 14: still the OLD task's (an
       older epoch of this pool: free for the newer task); 15: cancelled (its open-game index item went with it). */
    for (const n of [11, 12, 13]) assert.equal(await releaseGame(admin, table, gameId(n), old.writer.fence), true);
    const b = await take(table, "pool-b", "task-b1");
    assert.equal((await claimGame(admin, table, gameId(12), b.writer.fence)).kind, "claimed");
    const moved = transitionFinancial(financial(15), { kind: "cancel-before-deal", at: 12 });
    assert.equal(moved.kind, "moved");
    assert.equal((await fin.put((moved as { next: ReturnType<typeof financial> }).next, 1)).kind, "committed");

    const current = await take(table, "pool-a", "task-a2");
    const refreshed: string[] = [];
    const own = createPoolGameOwnership({ client: current.client, table, writer: current.writer, timing: TIMING, onClaimed: async (id) => void refreshed.push(id) });
    const loaded: string[] = [];
    const reader = createDynamoFinancialStore({ client: current.client, table, fence: current.writer.fence, timing: TIMING });
    const pass = await own.sweepMoneyClaims({ financial: reader, continues: (record) => record.game_id !== gameId(13), beforeRetake: () => true, onSwept: async (id) => void loaded.push(id) });
    assert.deepEqual([...pass.claimed].sort(), [gameId(11), gameId(14)].sort());
    assert.deepEqual([...loaded].sort(), [gameId(11), gameId(14)].sort(), "each claimed game handed on (L5-7 loads it)");
    assert.deepEqual([...refreshed].sort(), [gameId(11), gameId(14)].sort(), "each claim ran its claim hook");
    assert.equal(pass.elsewhere, 1);
    assert.equal(pass.skipped, 1);
    assert.deepEqual(pass.failed, []);
    assert.equal((await readHead(admin, table, gameId(13)))?.owner_pool, NO_OWNER, "not continued: not claimed");
    assert.equal((await readHead(admin, table, gameId(15)))?.owner_pool, "pool-a", "a closed game is never visited");
    assert.equal((await readHead(admin, table, gameId(15)))?.pool_epoch, 1);
    const again = await own.sweepMoneyClaims({ financial: reader, continues: () => true, beforeRetake: () => true });
    assert.deepEqual(again.claimed, [gameId(13)], "the second pass claims what now qualifies");
    assert.equal(again.owned, 2);
    /* A stale task's sweep claims nothing. */
    const stale = createPoolGameOwnership({ client: old.client, table, writer: old.writer, timing: TIMING });
    await old.writer.check();
    const none = await stale.sweepMoneyClaims({ financial: reader, continues: () => true, beforeRetake: () => true });
    assert.deepEqual(none.claimed, []);
  });
  test("the sweep's review fixes: a resident actor not yet quiescent defers the claim-back; a failed hand-on is handed on again at the next pass; a damaged HEAD is never read as a takeover", async () => {
    const table = await tables.create("sweep2");
    const old = await take(table, "pool-a", "task-a1");
    const fin = createDynamoFinancialStore({ client: old.client, table, fence: old.writer.fence, timing: TIMING });
    for (const n of [21, 22, 23]) assert.equal((await fin.create(financial(n))).outcome.kind, "committed");
    for (const n of [21, 22]) assert.equal(await releaseGame(admin, table, gameId(n), old.writer.fence), true);
    /* 23: its HEAD damaged -- owned by this pool, but no epoch (not a takeover: damage). */
    await put(table, { ...headKey(gameId(23)), owner_pool: S("pool-a"), log_next_index: N(0), log_bytes: N(0) });

    const current = await take(table, "pool-a", "task-a2");
    const own = createPoolGameOwnership({ client: current.client, table, writer: current.writer, timing: TIMING });
    const reader = createDynamoFinancialStore({ client: current.client, table, fence: current.writer.fence, timing: TIMING });
    let busy = true;
    let failOnce = true;
    const handed: string[] = [];
    const first = await own.sweepMoneyClaims({
      financial: reader,
      continues: () => true,
      beforeRetake: (id) => !(id === gameId(21) && busy),
      onSwept: async (id) => {
        handed.push(id);
        if (id === gameId(22) && failOnce) {
          failOnce = false;
          throw new Error("the load failed");
        }
      },
    });
    assert.deepEqual(first.claimed, [], JSON.stringify(first));
    assert.equal((await readHead(admin, table, gameId(21)))?.owner_pool, NO_OWNER, "not re-claimed under a resident actor that is not quiescent");
    assert.equal((await readHead(admin, table, gameId(22)))?.owner_pool, "pool-a", "22 was claimed; its hand-on failed");
    assert.deepEqual(first.failed.map((f) => f.gameId).sort(), [gameId(21), gameId(22), gameId(23)].sort());
    assert.deepEqual(current.lost, [], "a damaged HEAD is not a takeover");
    await assert.rejects(own.claim(gameId(23)), (error: Error) => !(error instanceof GameOwnershipLostError) && /damage/.test(error.message), "a load of it is refused as damage, never as a loss");
    assert.deepEqual(current.lost, []);

    busy = false;
    const second = await own.sweepMoneyClaims({ financial: reader, continues: () => true, beforeRetake: () => true, onSwept: async (id) => void handed.push(id) });
    assert.deepEqual([...second.claimed].sort(), [gameId(21), gameId(22)].sort(), "21 now; 22 handed on again");
    assert.deepEqual(handed.filter((id) => id === gameId(22)).length, 2);
    const third = await own.sweepMoneyClaims({ financial: reader, continues: () => true, beforeRetake: () => true, onSwept: async (id) => void handed.push(id) });
    assert.deepEqual(third.claimed, []);
    assert.equal(third.owned, 2, "owned, and handed on: not handed on again");
    /* An owned game whose actor is not resident (its load failed after its claim, or it was evicted) is handed on. */
    const fourth = await own.sweepMoneyClaims({ financial: reader, continues: () => true, beforeRetake: () => true, isResident: (id) => id !== gameId(21), onSwept: async (id) => void handed.push(id) });
    assert.deepEqual(fourth.claimed, [gameId(21)]);
    assert.equal(fourth.owned, 1);
  });
});
