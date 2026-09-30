// server/src/persistence/conformance/taskStatus.dynamoLocal.test.ts
//
// ==================================================================
//  LIVE-6 L6-5A: THE TASK# STATUS ITEM AND THE METRIC LINES OF THE REAL RUNTIME -- ON DYNAMODB LOCAL
// ==================================================================
//
// Runs ONLY against a DynamoDB Local named by GS_DYNAMODB_LOCAL_ENDPOINT (`npm run test:dynamodb-local`); without one it
// FAILS with instructions. What it proves on real tables:
//   §1 the writer's condition, as DynamoDB evaluates it: a first write lands; a newer `seq` replaces; an older or equal
//      `seq` is refused (`stale`) and changes nothing; a table that is not there is `failed`, never a throw;
//   §2 the runtime over `realAwsSubstrate` (the L5-7 composition): the primary writes `TASK#<task>` from its pool takeover
//      on -- its epoch, generation, role, phase and TTL -- and `stopping` at its graceful shutdown; a non-primary task
//      writes `non-primary`; the metric lines of the run are CloudWatch EMF with only the Environment and Pool dimensions; and the
//      item changes nothing the certified composition decides (the same steps, the same shutdown order);
//   §3 a newer task of the same pool supersedes the older: its real pool writer's loss is ONE TaskLost with the cause
//      `pool-superseded` and TaskSuperseded (the text the classification reads is the pool writer's own).

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { GetItemCommand, PutItemCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createDynamoDbClient, deadline, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../../aws/awsClients";
import { readRouting, setPrimaryPool } from "../../aws/game/routing";
import { bootstrapGenerationMarker, generationMarkerItem } from "../../aws/game/generationMarker";
import { LEDGER_KEYS } from "../../aws/ledger/dynamoSigningLedger";
import { startAwsRuntime, type AwsRuntime } from "../../aws/runtime/awsRuntime";
import { realAwsSubstrate } from "../../aws/runtime/awsSubstrate";
import { AWS_RUNTIME_CONFIG_FORMAT, parseAwsRuntimeConfig } from "../../aws/runtime/runtimeConfig";
import { createEmfSink, METRIC_NAMESPACE } from "../../aws/runtime/runtimeMetrics";
import { dynamoTaskStatusWriter, TASK_STATUS_TTL_SECONDS, taskStatusKey, type TaskStatus } from "../../aws/runtime/taskStatus";
import { createMemoryOpsRecorder } from "../opsRecorder";
import { quietConsole } from "../../rooms/testSupport";
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

const LEDGER_ARN = "arn:aws:dynamodb:us-east-1:210987654321:table/gs-l65a-ledger";

async function awsTables(label: string, primary: string): Promise<{ game: string; identity: string; ledger: string }> {
  const game = await tables.create(`${label}-game`);
  const identity = await tables.create(`${label}-identity`);
  const ledger = await tables.create(`${label}-ledger`);
  await admin.send(new PutItemCommand({ TableName: ledger, Item: { ...LEDGER_KEYS.appgen(), schema: N(1), current_generation: N(1) } }), { abortSignal: deadline() });
  const routing = await readRouting(admin, game);
  assert.equal((await setPrimaryPool(admin, game, { pool: primary, expectedVersion: routing?.routing_version ?? null, by: "pipeline", now: 1 })).kind, "set");
  /* LIVE-6 L6-4 (converged, as L6-2's 0e55722 did for L6-1's fixture): the first deployment's bootstrap marks the first
     game table with its generation. */
  const marker = bootstrapGenerationMarker({ generation: 1, gameTable: "gs-l65a-game-g1", by: "l5-8-bootstrap", now: 1 });
  await admin.send(new PutItemCommand({ TableName: game, Item: generationMarkerItem(marker), ConditionExpression: "attribute_not_exists(pk)" }), { abortSignal: deadline() });
  return { game, identity, ledger };
}

const config = (pool: string) =>
  parseAwsRuntimeConfig({
    format: AWS_RUNTIME_CONFIG_FORMAT,
    environment: "local",
    region: "us-east-1",
    pool,
    generation: 1,
    game_table: "gs-l65a-game-g1",
    identity_table: "gs-l65a-identity",
    ledger_table_arn: LEDGER_ARN,
    escrow: null,
  });

async function taskItem(table: string, task: string): Promise<Record<string, AttributeValue> | null> {
  const got = await admin.send(new GetItemCommand({ TableName: table, Key: taskStatusKey(task), ConsistentRead: true }), { abortSignal: deadline() });
  return got.Item ?? null;
}

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, ms = 8_000): Promise<T> {
  const deadlineAt = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadlineAt) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function start(t: { game: string; identity: string; ledger: string }, task: string, pool: string, metricLines: string[]): Promise<{ runtime: AwsRuntime; exits: number[] }> {
  const exits: number[] = [];
  const app = await freshClient();
  const ledger = await freshClient();
  const runtime = await startAwsRuntime({
    config: config(pool),
    escrowConfig: null,
    server: { mode: "production", allowedOrigins: ["https://play.example"], trustedProxyHops: 1 },
    build: "l6-5a-ddb",
    port: 0,
    bindHost: "127.0.0.1",
    moneySwitch: undefined,
    task,
    substrate: realAwsSubstrate({ config: config(pool), clients: { app, ledger }, tables: t, timing: { maxResends: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined } }),
    ops: createMemoryOpsRecorder(),
    metrics: createEmfSink({ context: { environment: "local", pool }, now: () => Date.now(), write: (line) => metricLines.push(line) }),
    now: () => Date.now(),
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    exit: (code) => exits.push(code),
    timing: { sweepEveryMs: 3_600_000, sweepRetryMs: 20, relayerRetryMs: 3_600_000, failFastDelayMs: 5, drainEscrowMs: 1_000, drainOwnershipMs: 1_000, drainChainFactsMs: 500, drainIdentityMs: 2_000, statusEveryMs: 3_600_000 },
  });
  return { runtime, exits };
}

const status = (over: Partial<TaskStatus> = {}): TaskStatus => ({
  task: "t-ddb0000000000001",
  pool: "p1",
  poolEpoch: 1,
  generation: 1,
  environment: "local",
  build: "b",
  role: "primary",
  phase: "serving",
  ready: true,
  reasons: [],
  relayer: "not-configured",
  escrow: "not-configured",
  poolWriterCheckAgeMs: 0,
  startedAt: 1_760_000_000_000,
  ...over,
});

describe("L6-5A TASK# on DynamoDB Local", () => {
  test("§1 the writer's condition: first write, a newer seq replaces, an older or equal seq is refused and changes nothing; no table -> failed", async () => {
    const game = await tables.create("taskstatus");
    const client = await freshClient();
    const writer = dynamoTaskStatusWriter({ client, table: game });
    assert.equal(await writer.write(status({ phase: "starting" }), 1, 1_760_000_000_000), "written");
    assert.equal(await writer.write(status({ phase: "serving" }), 5, 1_760_000_005_000), "written");
    assert.equal(await writer.write(status({ phase: "stopping" }), 4, 1_760_000_009_000), "stale", "a late write never replaces a newer one");
    assert.equal(await writer.write(status({ phase: "stopping" }), 5, 1_760_000_009_000), "stale");
    const item = (await taskItem(game, "t-ddb0000000000001"))!;
    assert.deepEqual([item.phase?.S, item.seq?.N, item.updated_at?.N, item.ttl?.N], ["serving", "5", "1760000005000", String(1_760_000_005 + TASK_STATUS_TTL_SECONDS)]);
    const missing = dynamoTaskStatusWriter({ client, table: `${game}-not-there` });
    assert.equal(await missing.write(status(), 1, 1), "failed");
  });

  test("§2 the real composition writes it -- primary and non-primary -- and decides exactly as before; every metric line is EMF with Environment and Pool only", async () => {
    const t = await awsTables("rt", "p1");
    const lines: string[] = [];
    const primary = await start(t, "t-l65aprimary0001", "p1", lines);
    const first = (await taskItem(t.game, "t-l65aprimary0001"))!;
    assert.ok(first !== null, "written from the pool takeover on");
    assert.deepEqual([first.pool?.S, first.pool_epoch?.N, first.generation?.N, first.fmt?.N], ["p1", "1", "1", "1"]);
    /* Each tick is single flight (a tick while the last write is still out is skipped): tick until the item says it. */
    const serving = await until(
      async () => (primary.runtime.statusTick(), taskItem(t.game, "t-l65aprimary0001")),
      (item) => item?.phase?.S === "serving",
      "the serving status",
    );
    assert.deepEqual([serving!.role?.S, serving!.ready?.BOOL, serving!.reasons?.S], ["primary", true, "none"]);
    assert.ok(Number(serving!.ttl?.N) > Math.floor(Date.now() / 1000) + TASK_STATUS_TTL_SECONDS - 60);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await primary.runtime.shutdown();
    await until(() => taskItem(t.game, "t-l65aprimary0001"), (item) => item?.phase?.S === "stopping", "the stopping status");
    assert.deepEqual([...primary.runtime.shutdownSteps], ["readiness-503", "timers-stopped", "periodic-drained", "money-stopped", "relayer-stopped", "server-closed", "escrow-drained", "ownership-settled", "chain-facts-settled", "identity-settled", "pool-writer-stopped", "ops-flushed"]);
    assert.deepEqual(primary.exits, []);

    const s = await awsTables("sb", "p0");
    const standby = await start(s, "t-l65astandby0001", "p1", lines);
    assert.equal(standby.runtime.role, "non-primary");
    await until(async () => (standby.runtime.statusTick(), taskItem(s.game, "t-l65astandby0001")), (item) => item?.role?.S === "non-primary", "the non-primary task's status");
    await standby.runtime.shutdown();

    /* §3 a newer task of the SAME pool takes it over: the older one's own self-check (the real PoolWriter, L5-3) proves
       the loss -- ONE TaskLost with cause pool-superseded, and TaskSuperseded: the rolling-deploy loss, told apart from
       an unexpected one by the pool writer's own text. */
    const r = await awsTables("sup", "p1");
    const olderLines: string[] = [];
    const older = await start(r, "t-l65aolder000001", "p1", olderLines);
    const newer = await start(r, "t-l65anewer000001", "p1", []);
    const deadlineAt = Date.now() + 8_000;
    while (older.exits.length === 0 && Date.now() < deadlineAt) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(older.exits, [3]);
    const lost = olderLines.map((line) => JSON.parse(line) as Record<string, any>).filter((record) => record.event === "task-lost");
    assert.equal(lost.length, 1);
    assert.deepEqual([lost[0].TaskLost, lost[0].TaskSuperseded, lost[0].cause], [1, 1, "pool-superseded"]);
    await newer.runtime.shutdown();
    if (older.runtime.server !== null) await older.runtime.server.close().catch(() => undefined);
    lines.push(...olderLines);

    assert.ok(lines.length >= 4);
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, any>;
      for (const directive of record._aws.CloudWatchMetrics) {
        assert.equal(directive.Namespace, METRIC_NAMESPACE);
        for (const set of directive.Dimensions) for (const name of set) assert.ok(name === "Environment" || name === "Pool", name);
      }
      assert.ok(!/arn:|gs-l5conf|210987654321/.test(line), line);
    }
  });
});
