// server/src/persistence/conformance/l6_2Flip.dynamoLocal.test.ts
//
// ==================================================================
//  LIVE-6 L6-2: THE PRODUCTION FLIP, THE RECOVERY PASS, RETIREMENT AND THE L6-4 INTEGRATION -- ON DYNAMODB LOCAL
// ==================================================================
//
// Runs ONLY against a DynamoDB Local named by GS_DYNAMODB_LOCAL_ENDPOINT (`npm run test:dynamodb-local`); without one it
// FAILS with instructions. Real tables, the certified substrate as built, real runtimes (L5-7 / L6-1) -- no AWS.
//
//   §1 the flip end to end on real runtimes: A (p0) primary, B (p1) the non-primary router; a money game A's sweep claimed,
//      a resident no-money game, a game left on A's older epoch. The dry run and every refused flip (stale version,
//      missing evidence) write nothing; the applied flip opens the observability window BEFORE the CAS, moves the routing
//      once, and is settled ONLY by the restarted tasks' own takeovers (both exit 5; the promoted p1 task takes the
//      identity-writer role through the L5-7 order; the demoted p0 task comes back holding nothing). Retirement is refused
//      while A's old epoch still owns games; the recovery pass (dry run writes nothing) takes and releases exactly the
//      superseded ones, and the new primary's money sweep claims the money game; a re-run does nothing; the window closes;
//      retirement is then ready-to-drain, and `retired` only with drained evidence.
//   §2 the recovery pass's edges with pool writers: a current owner is never taken; a malformed HEAD is never touched;
//      another operator's hold is never touched; a hold of an interrupted recovery is resumed (released); a bounded pass
//      reports what remains and a re-run continues; a finished pass re-run does nothing; the primary is never "recovered".
//   §3 the flip CAS on its own: a lost answer settled by the claim (flipped, moved once); the observation bound passing
//      first STOPS (timeout; the window stays open); a re-run is refused (never moves twice); the roles observed later.
//   §4 (L6-4 item 3) the identity verifier refuses every table the serving path refuses: a fresh copy (its TABLE#identity
//      names the source), a replaying restore, a superseded source, a wrong TABLE#identity -- and serves a completed
//      restore; zero writes.
//   §5 (L6-4 item 5) `awsDeploy generation-gate`: closed until APPGEN adopted exactly this restore; open after; zero writes.
//   §6 (L6-4 item 8) the orphans report: ledger SETTLE#/ATTI# no game of the table accounts for; read-only.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CreateTableCommand, DeleteTableCommand, GetItemCommand, PutItemCommand, ScanCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createDynamoDbClient, deadline, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../../aws/awsClients";
import { EVIDENCE_MANIFEST_FORMAT, POOL_EVIDENCE_FILES } from "../../aws/controlPlane/evidence";
import { readFlipRecordFile, writeFlipRecord, type FlipRecord } from "../../aws/controlPlane/flipRecord";
import { runDeployCommand, EXIT_FAILED, EXIT_OK, type DeployDeps } from "../../aws/deploy/commands";
import { createDynamoFinancialStore } from "../../aws/game/dynamoFinancialStore";
import { createDynamoLogStore } from "../../aws/game/dynamoLogStore";
import { createDynamoRecordStore } from "../../aws/game/dynamoRecordStore";
import { gamePk, headKey, INTENT_PREFIX, NO_OWNER, readHead, type Item } from "../../aws/game/gameTable";
import { bootstrapGenerationMarker, generationMarkerItem, prepareRestoredTable } from "../../aws/game/generationMarker";
import { readRouting, setPrimaryPool } from "../../aws/game/routing";
import type { ResendTiming } from "../../aws/game/transact";
import { createDynamoIdentityStore, identityServingChecks, readIdentityRole, takeOverIdentityWriter } from "../../aws/identity/dynamoIdentityStore";
import { createDynamoSecurityJournal } from "../../aws/identity/dynamoSecurityJournal";
import { keyAttributes, keys } from "../../aws/identity/identityItems";
import { applyIdentityRestore, inspectIdentityRestore, type IdentityRestoreRequest } from "../../aws/identity/identityRestore";
import { createDynamoIdentityVerifier } from "../../aws/identity/identityVerifier";
import { adoptGeneration } from "../../aws/ledger/appGeneration";
import { LEDGER_KEYS } from "../../aws/ledger/dynamoSigningLedger";
import { closeFlipWindow, observeFlip, runFlip, type FlipDeps } from "../../aws/operator/flip";
import { takeGameAsOperator, type MutationContext } from "../../aws/operator/mutations";
import { EXIT, runAwsOperator } from "../../aws/operator/operatorMain";
import type { OperatorTarget } from "../../aws/operator/operatorTarget";
import { orphansReport } from "../../aws/operator/orphans";
import { RECOVERY_MARKER, recoverFromPool, type RecoveryReport } from "../../aws/operator/recovery";
import { retirementCheck } from "../../aws/operator/retire";
import { PoolWriter } from "../../aws/ownership/poolWriter";
import { preparedMarkerCheck } from "../../aws/recovery/recoveryOps";
import { takeIdentityWriterRole } from "../../aws/ownership/roles";
import { EXIT_ROLE_CHANGED, startAwsRuntime, type AwsRuntime } from "../../aws/runtime/awsRuntime";
import { realAwsSubstrate } from "../../aws/runtime/awsSubstrate";
import type { ParameterSource } from "../../aws/runtime/configSource";
import { AWS_RUNTIME_CONFIG_FORMAT_V2, parseAwsRuntimeConfig } from "../../aws/runtime/runtimeConfig";
import { readSessionCookie, type SessionCookieRead } from "../../identity/cookies";
import { IdentityService } from "../../identity/sessions";
import { createMemoryOpsRecorder } from "../opsRecorder";
import { quietConsole, seededRecord, ALICE, BOB } from "../../rooms/testSupport";
import { ConformanceTables, installFaults, newRunId, requireLocal } from "./dynamoLocal";
import { FaultScript } from "./faults";
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
const N = (value: number): AttributeValue => ({ N: String(value) });
const S = (value: string): AttributeValue => ({ S: value });
const WRITES = ["PutItemCommand", "UpdateItemCommand", "DeleteItemCommand", "TransactWriteItemsCommand", "BatchWriteItemCommand"];
const TIMING: Partial<ResendTiming> = { maxResends: 2, windowMs: 60_000, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined };
const noSleep = async () => undefined;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "l6-2-ddb-"));

quietConsole();

/** Tables that must carry an exact convention name (the generation gate's); dropped at the end like the others. */
const named: string[] = [];
async function namedTable(name: string): Promise<string> {
  await requireLocal(admin);
  await admin.send(
    new CreateTableCommand({ TableName: name, KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }], AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }], BillingMode: "PAY_PER_REQUEST" }),
    { abortSignal: deadline() },
  );
  named.push(name);
  return name;
}

after(async () => {
  for (const client of clients) client.destroy();
  for (const name of named) await admin.send(new DeleteTableCommand({ TableName: name }), { abortSignal: deadline() });
  await tables.dropAll();
  assert.deepEqual(tables.live, [], "every table this run made was dropped");
  admin.destroy();
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function freshClient(script: FaultScript = new FaultScript()): Promise<DynamoDBClient> {
  const client = createDynamoDbClient(TARGET);
  await requireLocal(client);
  installFaults(client, script);
  clients.push(client);
  return client;
}
const writesOf = (script: FaultScript): number => WRITES.reduce((sum, op) => sum + script.count(op), 0);

async function scanAll(table: string): Promise<Item[]> {
  const out: Item[] = [];
  let start: Item | undefined;
  do {
    const page = await admin.send(new ScanCommand({ TableName: table, ConsistentRead: true, ExclusiveStartKey: start }), { abortSignal: deadline() });
    out.push(...((page.Items ?? []) as Item[]));
    start = page.LastEvaluatedKey as Item | undefined;
  } while (start !== undefined);
  return out;
}
const sortedJson = (items: Item[]) => JSON.stringify(items.map((item) => JSON.stringify(item)).sort());
const put = (table: string, item: Item) => admin.send(new PutItemCommand({ TableName: table, Item: item }), { abortSignal: deadline() });
const raw = async (table: string, key: Item): Promise<Item | null> => (await admin.send(new GetItemCommand({ TableName: table, Key: key, ConsistentRead: true }), { abortSignal: deadline() })).Item ?? null;
async function restoreCopy(source: string, label: string): Promise<string> {
  const copy = await tables.create(label);
  for (const item of await scanAll(source)) await put(copy, item);
  return copy;
}

/* ------------------------------------------------------------------ */
/* A two-pool deployment (p0, p1) on real tables                        */
/* ------------------------------------------------------------------ */

const ENV = "l62";
const LEDGER_ARN = "arn:aws:dynamodb:us-east-1:210987654321:table/gs-l62-ledger";
const ROUTES = { p0: { ws_path: "/gs/p/p0" }, p1: { ws_path: "/gs/p/p1" } };
const docFor = (pool: string) =>
  parseAwsRuntimeConfig({
    format: AWS_RUNTIME_CONFIG_FORMAT_V2,
    environment: ENV,
    region: "us-east-1",
    pool,
    generation: 1,
    game_table: "gs-l62-game-g1",
    identity_table: "gs-l62-identity",
    ledger_table_arn: LEDGER_ARN,
    escrow: null,
    routes: ROUTES,
  });

interface Deployment {
  readonly game: string;
  readonly identity: string;
  readonly ledger: string;
  target(client: DynamoDBClient): OperatorTarget;
  all(): Promise<string>;
}

async function deployment(label: string): Promise<Deployment> {
  const game = await tables.create(`${label}-game`);
  const identity = await tables.create(`${label}-identity`);
  const ledger = await tables.create(`${label}-ledger`);
  await put(ledger, { ...LEDGER_KEYS.appgen(), schema: N(1), current_generation: N(1) });
  await put(game, generationMarkerItem(bootstrapGenerationMarker({ generation: 1, gameTable: docFor("p0").gameTable, by: "l5-8-bootstrap", now: 1 })));
  assert.equal((await setPrimaryPool(admin, game, { pool: "p0", expectedVersion: null, by: "pipeline", now: 1 })).kind, "set");
  return {
    game,
    identity,
    ledger,
    target: (client) => ({ kind: "dynamodb-local", app: client, ledger: client, tables: { game, identity, ledger }, config: docFor("p0"), source: { arn: null, version: null, file: "test" }, escrow: { state: "none" }, destroy: () => undefined }),
    all: async () => JSON.stringify([sortedJson(await scanAll(game)), sortedJson(await scanAll(identity)), sortedJson(await scanAll(ledger))]),
  };
}

interface Audit {
  readonly event: string;
  readonly fields: Record<string, unknown>;
}
function contextOf(target: OperatorTarget, audits: Audit[]): MutationContext {
  return { target, now: () => Date.now(), build: "l6-2-ddb", audit: (event, fields) => audits.push({ event, fields }), timing: TIMING };
}

/* ------------------------------------------------------------------ */
/* Control-plane evidence as capture-evidence writes it                 */
/* ------------------------------------------------------------------ */

const TG = (pool: string) => `arn:aws:elasticloadbalancing:us-east-1:1:targetgroup/gs-${ENV}-${pool}/${pool === "p0" ? "a0" : "b1"}`;
interface EvidenceShape {
  readonly primary: string;
  readonly desired?: Readonly<Record<string, number>>;
  readonly healthy?: Readonly<Record<string, boolean>>;
}
function writeEvidence(label: string, shape: EvidenceShape): string {
  const dir = path.join(scratch, `${label}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  const pools = ["p0", "p1"];
  const w = (file: string, doc: unknown) => fs.writeFileSync(path.join(dir, file), JSON.stringify(doc));
  w(POOL_EVIDENCE_FILES.manifest, { format: EVIDENCE_MANIFEST_FORMAT, captured_at: new Date().toISOString(), environment: ENV, pools });
  w(POOL_EVIDENCE_FILES.targetGroups, { TargetGroups: pools.map((p) => ({ TargetGroupArn: TG(p), TargetGroupName: `gs-${ENV}-${p}`, HealthCheckPath: "/gs/readyz", Matcher: { HttpCode: "200" }, TargetType: "ip" })) });
  w(POOL_EVIDENCE_FILES.services, {
    services: pools.map((p) => {
      const desired = shape.desired?.[p] ?? 1;
      const td = `arn:aws:ecs:us-east-1:1:task-definition/gs-${ENV}-${p}:3`;
      return { serviceName: `gs-${ENV}-${p}`, desiredCount: desired, runningCount: desired, pendingCount: 0, taskDefinition: td, deployments: [{ status: "PRIMARY", rolloutState: "COMPLETED", taskDefinition: td }], loadBalancers: [{ targetGroupArn: TG(p) }] };
    }),
  });
  for (const p of pools) {
    const up = (shape.desired?.[p] ?? 1) > 0;
    w(POOL_EVIDENCE_FILES.targetHealth(p), { TargetHealthDescriptions: up ? [{ Target: { Id: `10.0.0.${p === "p0" ? 10 : 11}` }, TargetHealth: { State: shape.healthy?.[p] === false ? "unhealthy" : "healthy" } }] : [] });
    fs.mkdirSync(path.join(dir, POOL_EVIDENCE_FILES.revisionsDir(p)));
    fs.writeFileSync(path.join(dir, POOL_EVIDENCE_FILES.revisionsDir(p), "gs-3.json"), JSON.stringify({ taskDefinition: { taskDefinitionArn: `arn:aws:ecs:us-east-1:1:task-definition/gs-${ENV}-${p}:3`, status: "ACTIVE" }, tags: [{ key: "gs:identity-layout", value: "2" }] }));
  }
  const rule = (priority: string, paths: string[], target: string | null) => ({
    Priority: priority,
    IsDefault: priority === "default",
    Conditions: paths.length === 0 ? [] : [{ Field: "path-pattern", Values: paths, PathPatternConfig: { Values: paths } }],
    Actions: [target === null ? { Type: "fixed-response" } : { Type: "forward", TargetGroupArn: target }],
  });
  w(POOL_EVIDENCE_FILES.listenerRules, { Rules: [rule("100", ["/gs/p/p0"], TG("p0")), rule("101", ["/gs/p/p1"], TG("p1")), rule("1000", ["/gs*"], TG(shape.primary)), rule("default", [], null)] });
  return dir;
}

/* ------------------------------------------------------------------ */
/* Real runtimes                                                        */
/* ------------------------------------------------------------------ */

interface Started {
  readonly runtime: AwsRuntime;
  readonly exits: number[];
}

async function start(d: Deployment, pool: string, task: string): Promise<Started> {
  const exits: number[] = [];
  const app = await freshClient();
  const t = { game: d.game, identity: d.identity, ledger: d.ledger };
  const runtime = await startAwsRuntime({
    config: docFor(pool),
    escrowConfig: null,
    server: { mode: "production", allowedOrigins: ["https://play.example"], trustedProxyHops: 1 },
    build: "l6-2-ddb",
    port: 0,
    bindHost: "127.0.0.1",
    moneySwitch: undefined,
    task,
    substrate: realAwsSubstrate({ config: docFor(pool), clients: { app, ledger: app }, tables: t, timing: { maxResends: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep } }),
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

async function until(predicate: () => boolean, label: string, ms = 10_000): Promise<void> {
  const deadlineAt = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadlineAt) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A pool writer of `pool` (a task's takeover of its pool: every older epoch of the pool is superseded from now on). */
async function writer(d: Deployment, pool: string, task: string): Promise<{ writer: PoolWriter; client: DynamoDBClient }> {
  const client = await freshClient();
  const w = await PoolWriter.take({ client, table: d.game, pool, task, now: () => Date.now(), onLost: () => undefined });
  return { writer: w, client };
}

/** A game `w` creates (its record's creation makes its HEAD and directory entry, owned by w's epoch); or an open money
 *  game (its financial record: HEAD and money index). */
async function makeGame(d: Deployment, w: { writer: PoolWriter; client: DynamoDBClient }, n: number, money = false): Promise<string> {
  /* An open money game in its funding phase: its financial record (FINKEYS -> FINIDX#) and HEAD, no room record yet. */
  if (money) {
    assert.equal((await createDynamoFinancialStore({ client: w.client, table: d.game, fence: w.writer.fence, timing: TIMING }).create(financial(n))).outcome.kind, "committed");
    return gameId(n);
  }
  const records = createDynamoRecordStore({ client: w.client, table: d.game, fence: w.writer.fence, timing: TIMING });
  assert.equal((await records.put(gameRecord(n), null)).kind, "committed");
  assert.equal((await createDynamoLogStore({ client: w.client, table: d.game, fence: w.writer.fence, timing: TIMING }).appendBatch(gameId(n), entries(0, 1))).kind, "committed");
  return gameId(n);
}

const ownerOf = async (d: Deployment, g: string) => {
  const head = await readHead(admin, d.game, g);
  return head === null ? null : `${head.owner_pool}@${head.pool_epoch}`;
};
const poolEpoch = async (d: Deployment, pool: string): Promise<number> => Number((await raw(d.game, { pk: S(`POOL#${pool}`), sk: S("POOL") }))?.writer_epoch?.N ?? "0");

/* ==================================================================
    §1 THE FLIP END TO END ON REAL RUNTIMES
   ================================================================== */
describe("§1 the production flip A -> B on real runtimes, the recovery pass, retirement", () => {
  test("dry run and refusals write nothing; the flip moves the routing once and settles only by the restarted tasks' own takeovers; recovery migrates exactly the superseded games (money claimed by B's sweep); retirement follows", async () => {
    const d = await deployment("flip");
    /* Before any runtime: an earlier task of p0 (epoch 1) made a money game and a plain game. */
    const old = await writer(d, "p0", "t-old");
    const money = await makeGame(d, old, 101, true);
    const leftover = await makeGame(d, old, 102);
    const a = await start(d, "p0", "t-a");
    const b = await start(d, "p1", "t-b");
    const later: Started[] = [];
    try {
      assert.equal(a.runtime.role, "primary");
      assert.equal(b.runtime.role, "non-primary");
      const epochA = await poolEpoch(d, "p0");
      assert.equal(await ownerOf(d, money), `p0@${epochA}`, "A's startup money sweep claimed the money game its pool's older epoch left");
      assert.equal(await ownerOf(d, leftover), "p0@1", "the plain game stays on the older epoch (nobody loaded it)");
      /* A resident no-money game on A (a player's table). */
      const resident = seededRecord([ALICE, BOB]);
      assert.equal((await a.runtime.server!.records.put(resident, null)).kind, "committed");
      await a.runtime.server!.lifecycle.loadGame(resident.game_id);
      assert.equal(await ownerOf(d, resident.game_id), `p0@${epochA}`);

      const audits: Audit[] = [];
      const script = new FaultScript();
      const t = d.target(await freshClient(script));
      const context = contextOf(t, audits);
      const routing = await readRouting(admin, d.game);
      const version = routing?.routing_version as number;
      const evidence = writeEvidence("flip", { primary: "p0" });
      const recordFile = path.join(scratch, "flip-record.json");
      let restarted = false;
      const deps: FlipDeps = {
        context,
        documents: async (pool) => docFor(pool),
        persist: (record) => writeFlipRecord(recordFile, record),
        /* The observation's poll: here ECS's part happens -- each task reads the routing (its watch), stops with exit 5,
           and its replacement starts. Nothing in the flip itself can promote anything. */
        sleep: async () => {
          if (restarted) return;
          restarted = true;
          await b.runtime.checkRouting();
          await a.runtime.checkRouting();
          await until(() => a.exits.length > 0 && b.exits.length > 0, "both tasks' exits");
          later.push(await start(d, "p1", "t-c"));
          later.push(await start(d, "p0", "t-d"));
        },
      };
      const before = await d.all();

      /* DRY RUN: every check, nothing written -- not even the record. */
      const dry = await runFlip(deps, { from: "p0", to: "p1", expectVersion: version, note: "planned flip drill", apply: false, evidence });
      assert.equal(dry.verdict, "planned", JSON.stringify(dry.preflight.checks.filter((c) => c.status === "fail")));
      assert.deepEqual(dry.preflight.checks.filter((c) => c.status === "fail"), []);
      /* REFUSED: a stale expectation; no evidence for --apply; a pool that is unhealthy. */
      const stale = await runFlip(deps, { from: "p0", to: "p1", expectVersion: version + 5, note: "stale", apply: true, evidence });
      assert.equal(stale.verdict, "refused");
      assert.ok(stale.preflight.checks.some((c) => c.status === "fail" && /expected version/.test(c.name)));
      const blind = await runFlip(deps, { from: "p0", to: "p1", expectVersion: version, note: "no evidence", apply: true, evidence: null });
      assert.equal(blind.verdict, "refused");
      const sick = await runFlip(deps, { from: "p0", to: "p1", expectVersion: version, note: "sick", apply: true, evidence: writeEvidence("sick", { primary: "p0", healthy: { p1: false } }) });
      assert.equal(sick.verdict, "refused");
      assert.ok(sick.preflight.checks.some((c) => c.status === "fail" && /target health p1/.test(c.name)));
      assert.equal(writesOf(script), 0, "the dry run and every refusal wrote nothing");
      assert.equal(await d.all(), before, "every table unchanged");
      assert.equal(audits.length, 0, "no audit: nothing happened");

      /* RETIREMENT is refused while A is the primary and holds the roles. */
      assert.equal((await retirementCheck(t, "p0", null)).verdict, "blocked");

      /* THE FLIP. */
      const record = await runFlip(deps, { from: "p0", to: "p1", expectVersion: version, note: "planned flip drill", apply: true, evidence, observeMs: 60_000, pollMs: 10 });
      assert.equal(record.verdict, "roles-settled", JSON.stringify(record.observations.at(-1)));
      assert.deepEqual([a.exits, b.exits], [[EXIT_ROLE_CHANGED], [EXIT_ROLE_CHANGED]], "both ended with the planned role change");
      const events = audits.map((x) => x.event);
      assert.ok(events.indexOf("operator.flip-window") < events.indexOf("operator.set-primary"), `the window opened BEFORE the CAS: ${events.join(", ")}`);
      assert.ok(events.includes("operator.flip-roles-settled"));
      const moved = await readRouting(admin, d.game);
      assert.deepEqual([moved?.primary_pool, moved?.routing_version], ["p1", version + 1], "moved exactly once");
      const [c, dd] = later;
      assert.equal(c.runtime.role, "primary");
      assert.equal(dd.runtime.role, "non-primary");
      const role = await readIdentityRole(admin, d.identity);
      assert.deepEqual([role?.pool, role?.task], ["p1", "t-c"], "the promoted task took the identity-writer role itself (L5-7 order)");
      assert.equal(await ownerOf(d, resident.game_id), `${NO_OWNER}@${epochA}`, "the demoted primary released its resident no-money game");
      assert.equal(await ownerOf(d, money), `p0@${epochA}`, "the money game is still on A's (now superseded) epoch");
      assert.ok((await poolEpoch(d, "p0")) > epochA, "A's pool restarted: its old epoch is superseded");
      /* The record on disk is L6-6's evidence: the verifier reads the flip it describes. */
      assert.deepEqual(readFlipRecordFile(recordFile), { from: "p0", to: "p1", version: version + 1, since: record.window?.opened_at, rollback: false }, "judged from the window's opening (review L4)");
      assert.equal(record.window?.closed_at, null, "the window stays open until the recovery settles");

      /* RETIREMENT is still refused: A's old epoch owns games. */
      const blocked = await retirementCheck(t, "p0", null);
      assert.equal(blocked.verdict, "blocked");
      assert.ok(blocked.checks.some((x) => x.status === "fail" && /R3 no game names it/.test(x.name) && x.detail.includes(money) && x.detail.includes(leftover)), JSON.stringify(blocked.checks));

      /* RECOVERY, dry run: planned exactly the superseded games; nothing written. */
      const writesBefore = writesOf(script);
      const state = await d.all();
      const recoverDeps = { context, sleep: async () => void (await c.runtime.sweepNow()) };
      const plan = await recoverFromPool(recoverDeps, { from: "p0", note: "after the flip", apply: false });
      assert.deepEqual([...plan.planned].sort(), [money, leftover].sort());
      assert.deepEqual(plan.unresolved, []);
      assert.equal(writesOf(script), writesBefore, "the dry run wrote nothing");
      assert.equal(await d.all(), state);

      /* RECOVERY: take + release each; the new primary's money sweep claims the money game. */
      const done: RecoveryReport = await recoverFromPool(recoverDeps, { from: "p0", note: "after the flip", apply: true, moneyWaitMs: 10_000, pollMs: 10 });
      assert.deepEqual(done.unresolved, [], JSON.stringify(done));
      assert.deepEqual(done.acted.map((x) => [x.game_id, x.action, x.money]).sort(), [[money, "taken-and-released", true], [leftover, "taken-and-released", false]].sort());
      assert.deepEqual(done.money_claimed, [money]);
      assert.equal(done.settled, true);
      assert.equal(await ownerOf(d, money), `p1@${await poolEpoch(d, "p1")}`, "claimed by B's current task (its money sweep)");
      assert.equal((await readHead(admin, d.game, leftover))?.owner_pool, NO_OWNER, "released: the next load is the primary's");
      /* Re-run: nothing to do. */
      const again = await recoverFromPool(recoverDeps, { from: "p0", note: "after the flip", apply: true, moneyWaitMs: 1_000, pollMs: 10 });
      assert.deepEqual([again.acted.length, again.unresolved.length, again.settled], [0, 0, true]);
      const closed = closeFlipWindow(context, record, "the recovery of p0 settled");
      assert.notEqual(closed.window?.closed_at, null);
      assert.equal(audits.filter((x) => x.event === "operator.flip-window").map((x) => x.fields.phase).join(","), "open,closed");

      /* RETIREMENT of A: ready to drain; retired only with drained evidence; the primary never. */
      const ready = await retirementCheck(t, "p0", null);
      assert.equal(ready.verdict, "ready-to-drain", JSON.stringify(ready.checks.filter((x) => x.status === "fail")));
      assert.equal((await retirementCheck(t, "p0", writeEvidence("undrained", { primary: "p1" }))).verdict, "ready-to-drain", "not drained: not retired");
      assert.equal((await retirementCheck(t, "p0", writeEvidence("drained", { primary: "p1", desired: { p0: 0 } }))).verdict, "retired");
      assert.equal((await retirementCheck(t, "p1", null)).verdict, "blocked", "the primary is never retired");
      /* A flip back onto a drained pool is refused. */
      const back = await runFlip(deps, { from: "p1", to: "p0", expectVersion: version + 1, note: "back", apply: true, evidence: writeEvidence("back", { primary: "p1", desired: { p0: 0 } }) });
      assert.equal(back.verdict, "refused");
      assert.ok(back.preflight.checks.some((x) => x.status === "fail" && /is running/.test(x.name)));
    } finally {
      if (a.exits.length === 0) await a.runtime.shutdown();
      if (b.exits.length === 0) await b.runtime.shutdown();
      for (const s of later) await s.runtime.shutdown();
    }
  });
});

/* ==================================================================
    §2 THE RECOVERY PASS'S EDGES
   ================================================================== */
describe("§2 the recovery pass: superseded only, resumable, bounded, idempotent", () => {
  test("current owner, malformed HEAD and another operator's hold are never touched; an interrupted recovery's hold is released; a bounded pass continues; a finished pass does nothing", async () => {
    const d = await deployment("rec");
    const audits: Audit[] = [];
    await writer(d, "p1", "t-b1");
    const routing = await readRouting(admin, d.game);
    assert.equal((await setPrimaryPool(admin, d.game, { pool: "p1", expectedVersion: routing?.routing_version ?? null, by: "pipeline", now: 2 })).kind, "set");
    const a1 = await writer(d, "p0", "t-a1");
    const [g1, g2, g4, g5, g6] = [await makeGame(d, a1, 1), await makeGame(d, a1, 2), await makeGame(d, a1, 4), await makeGame(d, a1, 5), await makeGame(d, a1, 6)];
    const a2 = await writer(d, "p0", "t-a2");
    const g3 = await makeGame(d, a2, 3); // CURRENT: p0's current task owns it
    /* g2's HEAD is damaged (an attribute no build writes). */
    const head2 = (await raw(d.game, headKey(g2))) as Item;
    await put(d.game, { ...head2, garbage: S("x") });
    const damaged = sortedJson([(await raw(d.game, headKey(g2))) as Item]);
    const t = d.target(await freshClient());
    const context = contextOf(t, audits);
    /* g4: another operator's hold. g5: a hold of an interrupted run of THIS recovery (its take landed, its release did not). */
    assert.equal((await takeGameAsOperator(context, { gameId: g4, note: "someone else's investigation", apply: true })).kind, "applied");
    assert.equal((await takeGameAsOperator(context, { gameId: g5, note: `${RECOVERY_MARKER("p0")} interrupted`, apply: true })).kind, "applied");
    const g4Owner = await ownerOf(d, g4);
    const deps = { context, sleep: noSleep };

    /* The primary is never "recovered". */
    const primary = await recoverFromPool(deps, { from: "p1", note: "wrong pool", apply: true });
    assert.equal(primary.acted.length, 0);
    assert.match(primary.problems.join(" "), /p1 is the primary/);

    const script = new FaultScript();
    const dryContext = contextOf(d.target(await freshClient(script)), audits);
    const dry = await recoverFromPool({ context: dryContext, sleep: noSleep }, { from: "p0", note: "pass", apply: false });
    assert.equal(writesOf(script), 0, "the dry run wrote nothing");
    assert.deepEqual([...dry.planned].sort(), [g1, g5, g6].sort());
    const unresolvedOf = (r: RecoveryReport) => Object.fromEntries(r.unresolved.map((u) => [u.game_id, u.class]));
    assert.deepEqual(unresolvedOf(dry), { [g2]: "unknown", [g3]: "current", [g4]: "operator" }, JSON.stringify(dry.unresolved));

    /* Bounded: one game per pass; the rest remains; not settled. */
    const first = await recoverFromPool(deps, { from: "p0", note: "pass", apply: true, limit: 1 });
    assert.deepEqual(first.acted.map((x) => [x.game_id, x.action]), [[g1, "taken-and-released"]]);
    assert.equal(first.remaining, 2);
    assert.equal(first.settled, false);
    /* The re-run continues: the interrupted hold is released (resumed), the last superseded game taken and released. */
    const second = await recoverFromPool(deps, { from: "p0", note: "pass", apply: true });
    assert.deepEqual(second.acted.map((x) => [x.game_id, x.action]).sort(), [[g5, "resumed-release"], [g6, "taken-and-released"]].sort());
    assert.equal(second.remaining, 0);
    assert.equal(second.settled, false, "unresolved games remain (current, malformed, another's hold): never settled over them");
    assert.deepEqual(unresolvedOf(second), { [g2]: "unknown", [g3]: "current", [g4]: "operator" });
    /* A finished pass re-run acts on nothing. */
    const third = await recoverFromPool(deps, { from: "p0", note: "pass", apply: true });
    assert.equal(third.acted.length, 0);
    for (const g of [g1, g5, g6]) assert.equal((await readHead(admin, d.game, g))?.owner_pool, NO_OWNER, `${g} released`);
    assert.equal(await ownerOf(d, g3), `p0@${await poolEpoch(d, "p0")}`, "the current owner kept its game");
    assert.equal(await ownerOf(d, g4), g4Owner, "another operator's hold untouched");
    assert.equal(sortedJson([(await raw(d.game, headKey(g2))) as Item]), damaged, "the malformed HEAD untouched");
    /* Retirement is blocked by the current owner (and the unreadable HEAD). */
    const blocked = await retirementCheck(t, "p0", null);
    assert.equal(blocked.verdict, "blocked");
    assert.ok(blocked.checks.some((x) => x.status === "fail" && x.name === "R3 no game names it" && x.detail.includes(g3)));
    void a2;
  });
});

/* ==================================================================
    §3 THE FLIP CAS: A LOST ANSWER, A TIMEOUT, A RE-RUN
   ================================================================== */
describe("§3 the flip's CAS on its own", () => {
  test("a lost answer is settled by the claim (moved once); the observation bound stops the procedure (the window stays open); a re-run is refused; the roles are observed once the tasks restart", async () => {
    const d = await deployment("cas");
    const a = await writer(d, "p0", "t-a");
    assert.equal((await takeIdentityWriterRole(a.writer, { client: a.client, table: d.identity }, { now: () => Date.now() })).kind, "taken");
    await writer(d, "p1", "t-b");
    const audits: Audit[] = [];
    const lost = new FaultScript([{ op: "PutItemCommand", where: (detail) => detail.includes('"ROUTING"'), action: { kind: "lose-answer" } }]);
    const context = contextOf(d.target(await freshClient(lost)), audits);
    const deps: FlipDeps = { context, documents: async (pool) => docFor(pool), sleep: noSleep };
    const evidence = writeEvidence("cas", { primary: "p0" });
    const record = await runFlip(deps, { from: "p0", to: "p1", expectVersion: 1, note: "cas drill", apply: true, evidence, observeMs: 0, pollMs: 1 });
    assert.deepEqual(lost.unfired(), [], "the answer was lost");
    assert.equal(record.cas?.outcome, "applied", JSON.stringify(record.cas));
    assert.equal(record.verdict, "timeout", "nothing restarted within the bound: STOP, nothing assumed");
    assert.equal(record.window?.closed_at, null);
    assert.ok(audits.some((x) => x.event === "operator.flip-timeout"));
    const moved = await readRouting(admin, d.game);
    assert.deepEqual([moved?.primary_pool, moved?.routing_version], ["p1", 2]);
    /* The same flip again: refused (the routing names p1 at 2) -- it can never move twice. */
    const again = await runFlip(deps, { from: "p0", to: "p1", expectVersion: 1, note: "cas drill", apply: true, evidence });
    assert.equal(again.verdict, "refused");
    assert.equal((await readRouting(admin, d.game))?.routing_version, 2);
    /* The tasks restart (their own takeovers): flip-observe resumes the record and settles. */
    const b2 = await writer(d, "p1", "t-b2");
    assert.equal((await takeIdentityWriterRole(b2.writer, { client: b2.client, table: d.identity }, { now: () => Date.now() })).kind, "taken");
    await writer(d, "p0", "t-a2");
    const settled: FlipRecord = await observeFlip(deps, record, { observeMs: 5_000, pollMs: 1 });
    assert.equal(settled.verdict, "roles-settled", JSON.stringify(settled.observations.at(-1)));
  });
});

describe("§3b interrupted, raced and rolled-back flips (review H1, L3, M3)", () => {
  async function twoPools(label: string) {
    const d = await deployment(label);
    const a = await writer(d, "p0", "t-a");
    assert.equal((await takeIdentityWriterRole(a.writer, { client: a.client, table: d.identity }, { now: () => Date.now() })).kind, "taken");
    await writer(d, "p1", "t-b");
    return d;
  }

  test("interrupted after the window opened (the CAS landed, its record never said so): flip-observe settles it from SYSTEM/ROUTING; one that never landed stays UNKNOWN; a new flip never overwrites that record", async () => {
    const d = await twoPools("h1");
    const persisted: FlipRecord[] = [];
    const audits: Audit[] = [];
    const deps: FlipDeps = { context: contextOf(d.target(await freshClient()), audits), documents: async (pool) => docFor(pool), sleep: noSleep, persist: (r) => persisted.push(r) };
    const evidence = writeEvidence("h1", { primary: "p0" });
    const done = await runFlip(deps, { from: "p0", to: "p1", expectVersion: 1, note: "interrupted drill", apply: true, evidence, observeMs: 0 });
    assert.equal(done.cas?.outcome, "applied");
    /* The last record on disk had the process died right after the window opened: planned, window, no CAS. */
    const interrupted = persisted.find((r) => r.window !== null && r.cas === null) as FlipRecord;
    assert.ok(interrupted !== undefined && interrupted.verdict === "planned");
    const settled = await observeFlip(deps, interrupted, { observeMs: 0, pollMs: 1 });
    assert.equal(settled.cas?.outcome, "applied", JSON.stringify(settled.cas));
    assert.equal(settled.cas?.run, done.cas?.run, "the run that moved it, read from the routing");
    assert.equal(settled.verdict, "timeout", "then observed (nothing restarted here): never a dry run, never assumed");
    assert.ok(audits.some((x) => x.event === "operator.flip-settled"));
    /* A record whose CAS never landed (the routing still names A at 1) stays UNKNOWN: re-run with a new record. */
    const other = await twoPools("h1b");
    const otherDeps: FlipDeps = { ...deps, context: contextOf(other.target(await freshClient()), []) };
    const never = await observeFlip(otherDeps, { ...interrupted, cas: null }, { observeMs: 0 });
    assert.equal(never.verdict, "unknown");
    assert.match(never.cas?.detail ?? "", /has not landed/);
    assert.equal((await readRouting(admin, other.game))?.routing_version, 1, "settling never writes the routing");
    /* The CLI refuses to write a NEW flip over a record whose window opened. */
    const recordFile = path.join(scratch, "h1-record.json");
    writeFlipRecord(recordFile, interrupted);
    const doc = JSON.stringify({ format: AWS_RUNTIME_CONFIG_FORMAT_V2, environment: ENV, region: "us-east-1", pool: "p0", generation: 1, game_table: "gs-l62-game-g1", identity_table: "gs-l62-identity", ledger_table_arn: LEDGER_ARN, escrow: null, routes: ROUTES });
    const err: string[] = [];
    const code = await runAwsOperator(["flip", "p0", "p1", "--expect-version", "2", "--note", "again", "--evidence", evidence, "--flip-record", recordFile, "--apply", "--local-document", "doc.json"], { GS_DYNAMODB_LOCAL_ENDPOINT: TARGET.endpoint }, { out: () => undefined, err: (l) => err.push(l) }, { readFile: async () => doc, clientFor: () => createDynamoDbClient(TARGET) });
    assert.equal(code, EXIT.usage, err.join("\n"));
    assert.match(err.join("\n"), /whose window opened .* flip-observe/);
  });

  test("a task that restarts between the preflight and the CAS refuses the flip (the baseline is the state at the CAS)", async () => {
    const d = await twoPools("l3");
    let restarted = false;
    const deps: FlipDeps = {
      context: contextOf(d.target(await freshClient()), []),
      documents: async (pool) => {
        if (pool === "p1" && !restarted) {
          restarted = true;
          await writer(d, "p1", "t-b-crashed-and-back");
        }
        return docFor(pool);
      },
      sleep: noSleep,
    };
    const record = await runFlip(deps, { from: "p0", to: "p1", expectVersion: 1, note: "l3", apply: true, evidence: writeEvidence("l3", { primary: "p0" }) });
    assert.equal(record.verdict, "refused");
    assert.ok(record.preflight.checks.some((c) => c.status === "fail" && c.name === "unchanged since the preflight"));
    assert.equal((await readRouting(admin, d.game))?.routing_version, 1, "the routing did not move");
  });

  test("B's promotion fails: a plain flip back is refused (the roles never moved), `--rollback` moves the routing back through the same preflight, window, CAS and observation", async () => {
    const d = await twoPools("m3");
    const deps: FlipDeps = { context: contextOf(d.target(await freshClient()), []), documents: async (pool) => docFor(pool), sleep: noSleep };
    const flipped = await runFlip(deps, { from: "p0", to: "p1", expectVersion: 1, note: "m3", apply: true, evidence: writeEvidence("m3", { primary: "p0" }), observeMs: 0 });
    assert.equal(flipped.verdict, "timeout", "B never promoted");
    /* B is failing: its target unhealthy; /gs* still on A (Terraform not applied). */
    const sick = writeEvidence("m3-sick", { primary: "p0", healthy: { p1: false } });
    const plain = await runFlip(deps, { from: "p1", to: "p0", expectVersion: 2, note: "back", apply: true, evidence: sick });
    assert.equal(plain.verdict, "refused");
    const back = await runFlip(deps, { from: "p1", to: "p0", expectVersion: 2, note: "rollback: p1 cannot start as primary", apply: true, evidence: sick, rollback: true, observeMs: 0 });
    assert.equal(back.cas?.outcome, "applied", JSON.stringify(back.preflight.checks.filter((c) => c.status === "fail")));
    assert.equal(back.rollback, true);
    assert.deepEqual([(await readRouting(admin, d.game))?.primary_pool, (await readRouting(admin, d.game))?.routing_version], ["p0", 3]);
    /* A's task restarts (its own takeover) and takes the role again; B's restart is reported, not required. */
    const a2 = await writer(d, "p0", "t-a2");
    assert.equal((await takeIdentityWriterRole(a2.writer, { client: a2.client, table: d.identity }, { now: () => Date.now() })).kind, "taken");
    const settled = await observeFlip(deps, back, { observeMs: 5_000, pollMs: 1 });
    assert.equal(settled.verdict, "roles-settled", JSON.stringify(settled.observations.at(-1)));
    assert.ok(settled.observations.at(-1)?.checks.some((c) => c.status === "skipped" && /p1 restarted/.test(c.name)));
  });
});

/* ==================================================================
    §4 THE IDENTITY VERIFIER ON RESTORE STATES (L6-4 item 3)
   ================================================================== */
const readOf = (setCookie: string | null | undefined): SessionCookieRead => readSessionCookie((setCookie as string).split(";")[0]);

async function spyClient(): Promise<{ client: DynamoDBClient; sent: string[] }> {
  const client = await freshClient();
  const sent: string[] = [];
  client.middlewareStack.add(
    (next, ctx) => async (args) => {
      sent.push(String((ctx as { commandName?: string }).commandName));
      return next(args);
    },
    { step: "initialize", name: "l6-2-spy" },
  );
  return { client, sent };
}

describe("§4 the identity verifier refuses every table the serving path refuses", () => {
  test("fresh copy, replaying restore, superseded source, wrong TABLE#identity: unavailable; a completed restore serves; zero writes", async () => {
    const ledger = await tables.create("v-ledger");
    await put(ledger, { ...LEDGER_KEYS.appgen(), schema: N(1), current_generation: N(1) });
    const source = await tables.create("v-identity");
    const { epoch } = await takeOverIdentityWriter(admin, source, { task: "t-live", pool: "p1", now: () => 1, checks: identityServingChecks(source) });
    let clock = 1_780_000_000_000;
    const now = () => clock;
    const store = createDynamoIdentityStore(admin, source, { epoch, sleep: noSleep });
    const identity = await IdentityService.open(store, { security: { journal: createDynamoSecurityJournal(admin, ledger, { generation: 1, sleep: noSleep }), grants: store.grants, clock: now } });
    const profile = async (service: IdentityService, name: string) => {
      clock += 60_000;
      const boot = await service.bootstrap({ kind: "none" }, false, now());
      const read = readOf((boot as { setCookie: string | null }).setCookie);
      assert.equal((await service.createProfile(read, name, now())).kind, "ok");
      await service.settled();
      return read;
    };
    const ann = await profile(identity, "Ann");
    await profile(identity, "Bea");
    const { client, sent } = await spyClient();
    const verify = (table: string, read: SessionCookieRead) => createDynamoIdentityVerifier(client, table).authenticate(read, now());
    assert.equal((await verify(source, ann)).kind, "ok", "the live, never-restored table serves");

    /* A point-in-time copy: its TABLE#identity names the source. */
    const restorePoint = clock;
    const restored = await restoreCopy(source, "v-restored");
    const copyRefusal = await verify(restored, ann);
    assert.equal(copyRefusal.kind, "unavailable", JSON.stringify(copyRefusal));
    /* A replaying restore (interrupted after one principal). */
    clock += 20 * 60_000;
    const request: IdentityRestoreRequest = { table: restored, restoreId: "r-l62-verifier", restorePoint, source: { kind: "fence", table: source }, by: "op-drill" };
    const deps = { client: admin, ledger: { client: admin, table: ledger }, now: () => clock + 3_600_000, sleep: noSleep };
    assert.equal((await applyIdentityRestore({ ...deps, stopAfter: 1 }, request)).kind, "incomplete");
    assert.equal((await inspectIdentityRestore(admin, restored)).marker?.state, "replaying");
    assert.equal((await verify(restored, ann)).kind, "unavailable", "a replaying restore serves nothing");
    /* Completed: the restored table serves (its old sessions were signed out; a new one authenticates). */
    assert.equal((await applyIdentityRestore(deps, request)).kind, "complete");
    assert.equal((await verify(source, ann)).kind, "unavailable", "the superseded source serves nothing");
    assert.notEqual((await verify(restored, ann)).kind, "ok", "an old session is signed out by the restore");
    const taken = await takeOverIdentityWriter(admin, restored, { task: "t-new", pool: "p1", now: () => 2, checks: identityServingChecks(restored) });
    const served = await IdentityService.open(createDynamoIdentityStore(admin, restored, { epoch: taken.epoch, sleep: noSleep }));
    const cat = await profile(served, "Cat");
    const ok = await verify(restored, cat);
    assert.equal(ok.kind, "ok", JSON.stringify(ok));
    /* A live table whose TABLE#identity names another table. */
    const other = await tables.create("v-other");
    await takeOverIdentityWriter(admin, other, { task: "t-other", pool: "p1", now: () => 1, checks: identityServingChecks(other) });
    const self = (await raw(other, keyAttributes(keys.self()))) as Item;
    await put(other, { ...self, identity_table: S(`${other}-elsewhere`) });
    assert.equal((await verify(other, cat)).kind, "unavailable", "a wrong TABLE#identity");
    assert.deepEqual([...new Set(sent)], ["GetItemCommand"], "the verifier sent nothing but GetItem: zero writes");
  });
});

/* ==================================================================
    §5 THE GENERATION GATE (L6-4 item 5)
   ================================================================== */
describe("§5 awsDeploy generation-gate: the switch never races ahead of the adoption", () => {
  test("closed before the adoption and for another restore; open after appgen-adopt committed exactly this restore; the gate writes nothing", async () => {
    /* The gate reads the table by the naming convention (gs-<env>-game-g<N>), exactly as the recovery tool prepared and
       adopted it: this run's own tables carry exactly those names (and are dropped at the end). */
    const env = `g${Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, "a")}`;
    const logical = { g1: `gs-${env}-game-g1`, g2: `gs-${env}-game-g2` };
    const ledger = await tables.create("gate-ledger");
    await put(ledger, { ...LEDGER_KEYS.appgen(), schema: N(1), current_generation: N(1) });
    const g1 = await namedTable(logical.g1);
    await put(g1, generationMarkerItem(bootstrapGenerationMarker({ generation: 1, gameTable: logical.g1, by: "l5-8-bootstrap", now: 1 })));
    const g2 = await namedTable(logical.g2);
    for (const item of await scanAll(g1)) await put(g2, item); // the point-in-time copy
    const restoreId = "r-l62-gate";
    assert.equal((await prepareRestoredTable(admin, g2, { gameTable: logical.g2, generation: 2, restoredFrom: { generation: 1, table: logical.g1 }, restorePoint: 1_000, restoreId, by: "op-drill", now: 2_000 })).kind, "prepared");
    const runtimeArn = `arn:aws:ssm:us-east-1:111111111111:parameter/gs/${env}/runtime/p1`;
    const document = JSON.stringify({ format: "18COSMOS/AWS-RUNTIME/v1", environment: env, region: "us-east-1", pool: "p1", generation: 1, game_table: logical.g1, identity_table: `gs-${env}-identity`, ledger_table_arn: `arn:aws:dynamodb:us-east-1:222222222222:table/gs-${env}-ledger`, escrow: null });
    const parameters: ParameterSource = {
      async read(arn) {
        if (arn !== runtimeArn) throw new Error(`no such parameter ${arn}`);
        return { value: document, version: 3, arn };
      },
    };
    const script = new FaultScript();
    const client = await freshClient(script);
    const lines: string[] = [];
    const deps: DeployDeps = {
      parameters,
      dynamo: () => client,
      kms: () => {
        throw new Error("no KMS here");
      },
      now: () => 1_790_000_000_000,
      out: (line) => lines.push(line),
      tables: ({ gameTable }) => ({ game: gameTable, identity: "unused", ledger }),
    };
    const gate = async (id = restoreId) => {
      lines.length = 0;
      return runDeployCommand(["generation-gate", "--runtime-parameter", runtimeArn, "--environment", env, "--generation", "2", "--restore-id", id], deps);
    };
    assert.equal(await gate(), EXIT_FAILED, lines.join("\n"));
    assert.match(lines.join("\n"), /GATE CLOSED/);
    assert.match(lines.join("\n"), /appgen-adopt/);
    /* L6-4's adoption, exactly as `npm run recovery -- appgen-adopt` makes it (its CAS; its prepared-marker check). */
    const adopted = await adoptGeneration(admin, ledger, { expected: 1, generation: 2, gameTable: logical.g2, restoreId, by: "op-drill" }, preparedMarkerCheck(admin), { now: () => 3_000, sleep: noSleep });
    assert.equal(adopted.kind, "committed");
    assert.equal(await gate(), EXIT_OK, lines.join("\n"));
    assert.match(lines.join("\n"), /GATE OPEN/);
    assert.match(lines.join("\n"), new RegExp(`generation_adoption = \\{ generation = 2, game_table = "${logical.g2}", restore_id = "${restoreId}" \\}`));
    assert.equal(await gate("r-l62-other"), EXIT_FAILED, "another restore's id");
    assert.match(lines.join("\n"), /GATE CLOSED/);
    assert.equal(writesOf(script), 0, "the gate only reads");
  });
});

/* ==================================================================
    §6 THE ORPHANS REPORT (L6-4 item 8)
   ================================================================== */
describe("§6 the restore's orphans report: read-only", () => {
  test("ledger reservations and attempts no game of the table accounts for are listed; held ones are not; chain games NOT COVERED; zero writes", async () => {
    const d = await deployment("orph");
    const a = await writer(d, "p0", "t-a");
    const g = await makeGame(d, a, 7);
    await put(d.game, { pk: S(gamePk(g)), sk: S(`${INTENT_PREFIX}held-intent`) });
    await put(d.ledger, { pk: S("ATTI#held-intent"), sk: S("A#1") });
    await put(d.ledger, { pk: S("ATTI#orphan-intent"), sk: S("A#1") });
    await put(d.ledger, { pk: S("SETTLE#orphan-instance"), sk: S("R#1") });
    const script = new FaultScript();
    const report = await orphansReport(d.target(await freshClient(script)));
    assert.deepEqual(report.settle_orphans, ["orphan-instance"]);
    assert.deepEqual(report.attempt_orphans, ["orphan-intent"]);
    assert.equal(report.intents_held, 1);
    assert.equal(report.chain_games.status, "not-covered");
    assert.equal(report.generation.origin, "bootstrap");
    assert.ok(report.problems.some((p) => /never restored/.test(p)));
    assert.equal(writesOf(script), 0);
  });
});
