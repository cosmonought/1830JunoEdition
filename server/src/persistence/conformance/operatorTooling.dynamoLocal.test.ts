// server/src/persistence/conformance/operatorTooling.dynamoLocal.test.ts
//
// ==================================================================
//  LIVE-6 L6-3: THE AWS OPERATOR TOOLING ON DYNAMODB LOCAL -- INSPECTION, THE ROUTING CAS, AND THE OPERATOR'S GAME FENCES
// ==================================================================
//
// Runs ONLY against a DynamoDB Local named by GS_DYNAMODB_LOCAL_ENDPOINT (`npm run test:dynamodb-local`); without one it
// FAILS with instructions. Every table is this run's own and is dropped at the end.
//
//   §1 read-only inspection of a real deployment (routing, APPGEN, pools, the identity-writer role, the relayer's mirror
//      against the ledger's fence, a game's owner, the open money games) -- and it writes NOTHING;
//   §2 absent, unreadable (damaged / a later build's) and unavailable are three different answers, item by item;
//   §3 the routing CAS: applied (with its evidence), a dry run writing nothing, a stale expectation, a CONCURRENT change
//      between the tool's read and its write (never overwritten), a lost answer (settled by the claim), an unknown one
//      (re-run: never moved twice), and every refusal (the first routing is L5-8's; an `op:` pool; a pool no task took;
//      an unreadable routing, left byte-identical);
//   §4 the operator's game fences: a released game claimed and released; a SUPERSEDED owner taken -- and every request of
//      the displaced task, delayed across the take, the release and the pool's reclaim, refused by its own fence (no
//      ABA); the NEGATIVE CONTROL: the same delay across a naive hold on a CURRENT owner lands after the owner's reclaim
//      (why the live-owner take is stopped); races between the tool's read and its write; a lost and an unknown answer;
//      the evidence written first; anything not fully understood refused;
//   §5 the CLI end to end: the answer on stdout, the AUDIT line on stderr, JSON, exit codes, no secret.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { GetItemCommand, PutItemCommand, TransactWriteItemsCommand, UpdateItemCommand, type AttributeValue, type DynamoDBClient, type TransactWriteItem } from "@aws-sdk/client-dynamodb";

import { createDynamoDbClient, deadline, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../../aws/awsClients";
import { gamePk, headKey, NO_OWNER, poolKey, queryAll, readHead, LOG_PREFIX, type Item } from "../../aws/game/gameTable";
import { claimGame, releaseGame, takeOverPool } from "../../aws/game/ownership";
import { readRouting, ROUTING_KEY, setPrimaryPool } from "../../aws/game/routing";
import { relayerRoleKey } from "../../aws/game/relayerRole";
import { createDynamoLogStore } from "../../aws/game/dynamoLogStore";
import { createDynamoRecordStore } from "../../aws/game/dynamoRecordStore";
import { createDynamoFinancialStore } from "../../aws/game/dynamoFinancialStore";
import type { ResendTiming } from "../../aws/game/transact";
import { LEDGER_KEYS, openDynamoSigningLedger } from "../../aws/ledger/dynamoSigningLedger";
import { PoolWriter } from "../../aws/ownership/poolWriter";
import { ledgerFencedHook, takeRelayerRole } from "../../aws/ownership/relayerRole";
import { takeIdentityWriterRole } from "../../aws/ownership/roles";
import { parseAwsRuntimeConfig } from "../../aws/runtime/runtimeConfig";
import { inspectDeployment, inspectGame, listGames, LIVE_OWNER_TAKE_STOPPED, oprunKey, oprunResultKey } from "../../aws/operator/inspect";
import { claimGameAsOperator, releaseGameAsOperator, setPrimary, takeGameAsOperator, type MutationContext, type MutationResult } from "../../aws/operator/mutations";
import { EXIT, runAwsOperator } from "../../aws/operator/operatorMain";
import type { EscrowView, OperatorTarget } from "../../aws/operator/operatorTarget";
import { RELAYER_ADDRESS } from "../../escrow/escrow3bSupport";
import { fenceScopeOf } from "../storeResult";
import { quietConsole } from "../../rooms/testSupport";
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
const TWI = "TransactWriteItemsCommand";
const WRITES = ["PutItemCommand", "UpdateItemCommand", "DeleteItemCommand", TWI, "BatchWriteItemCommand"];

/** Resends are real; their pacing is not (no test waits on a clock). */
const TIMING: Partial<ResendTiming> = { maxResends: 2, windowMs: 60_000, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined };

quietConsole();

after(async () => {
  for (const client of clients) client.destroy();
  await tables.dropAll();
  assert.deepEqual(tables.live, [], "every table this run made was dropped");
  admin.destroy();
});

/** A client of its own; every call it makes is recorded by `script` (and faults added to it apply to it only). */
async function freshClient(script: FaultScript = new FaultScript()): Promise<DynamoDBClient> {
  const client = createDynamoDbClient(TARGET);
  await requireLocal(client);
  installFaults(client, script);
  clients.push(client);
  return client;
}
const writesOf = (script: FaultScript): number => WRITES.reduce((sum, op) => sum + script.count(op), 0);

const put = (table: string, item: Record<string, AttributeValue>) => admin.send(new PutItemCommand({ TableName: table, Item: item }), { abortSignal: deadline() });
const raw = async (table: string, key: Item): Promise<Item | null> => (await admin.send(new GetItemCommand({ TableName: table, Key: key, ConsistentRead: true }), { abortSignal: deadline() })).Item ?? null;

interface Deployment {
  readonly game: string;
  readonly identity: string;
  readonly ledger: string;
  /** An operator target over `client` (default: a fresh recorded client). */
  target(client: DynamoDBClient, escrow?: EscrowView): OperatorTarget;
  /** The runtime document as a file would hold it (for the CLI's --local-document). */
  readonly document: string;
}

async function deployment(label: string, options: { readonly appgen?: number | null } = {}): Promise<Deployment> {
  const game = await tables.create(`${label}-game`);
  const identity = await tables.create(`${label}-id`);
  const ledger = await tables.create(`${label}-ledger`);
  if (options.appgen !== null) await put(ledger, { ...LEDGER_KEYS.appgen(), schema: N(1), current_generation: N(options.appgen ?? 1) });
  const doc = { format: "18COSMOS/AWS-RUNTIME/v1", environment: "l63", region: "us-east-1", pool: "p1", generation: 1, game_table: game, identity_table: identity, ledger_table_arn: `arn:aws:dynamodb:us-east-1:123456789012:table/${ledger}`, escrow: null };
  const config = parseAwsRuntimeConfig(doc);
  return {
    game,
    identity,
    ledger,
    document: JSON.stringify(doc),
    target: (client, escrow = { state: "none" }) => ({
      kind: "dynamodb-local",
      app: client,
      ledger: client,
      tables: { game, identity, ledger },
      config,
      source: { arn: null, version: null, file: "test" },
      escrow,
      destroy: () => undefined,
    }),
  };
}

function context(target: OperatorTarget, audits: Array<{ event: string; fields: Record<string, unknown> }> = []): MutationContext {
  let n = 0;
  return {
    target,
    now: () => 1_700_000_000_000 + (n += 1),
    build: "l63-test",
    audit: (event, fields) => audits.push({ event, fields }),
    timing: TIMING,
  };
}

async function writer(table: string, pool: string, task: string): Promise<{ writer: PoolWriter; client: DynamoDBClient; script: FaultScript; lost: string[] }> {
  const script = new FaultScript();
  const client = await freshClient(script);
  const lost: string[] = [];
  const w = await PoolWriter.take({ client, table, pool, task, now: () => 1_000, onLost: (reason) => lost.push(reason) });
  return { writer: w, client, script, lost };
}

async function primary(table: string, pool: string): Promise<void> {
  const routing = await readRouting(admin, table);
  const set = await setPrimaryPool(admin, table, { pool, expectedVersion: routing?.routing_version ?? null, by: "pipeline", now: 1 });
  assert.equal(set.kind, "set");
}

/** A game made by `w` (its record's creation makes its HEAD, owned by w's epoch), with `n` log entries. */
async function makeGame(table: string, w: { writer: PoolWriter; client: DynamoDBClient }, n: number, logEntries = 1): Promise<string> {
  const g = gameId(n);
  const records = createDynamoRecordStore({ client: w.client, table, fence: w.writer.fence, timing: TIMING });
  assert.equal((await records.put(gameRecord(n), null)).kind, "committed");
  if (logEntries > 0) assert.equal((await createDynamoLogStore({ client: w.client, table, fence: w.writer.fence, timing: TIMING }).appendBatch(g, entries(0, logEntries))).kind, "committed");
  return g;
}

const logCount = async (table: string, g: string): Promise<number> => (await queryAll(admin, table, gamePk(g), { prefix: LOG_PREFIX })).length;
const expectKind = (result: MutationResult, kind: MutationResult["kind"]) => assert.equal(result.kind, kind, JSON.stringify(result));
const runOf = (result: MutationResult): string => (result as { run: string }).run;

/* ==================================================================
    §1 READ-ONLY INSPECTION OF A REAL DEPLOYMENT -- AND IT WRITES NOTHING
   ================================================================== */
describe("§1 read-only inspection", () => {
  test("a serving deployment: the routing, APPGEN, the pool, the identity-writer role and the relayer (mirror = ledger fence), all current -- no finding, no write", async () => {
    const d = await deployment("i-serving");
    await primary(d.game, "p1");
    const a = await writer(d.game, "p1", "task-a");
    assert.equal((await takeIdentityWriterRole(a.writer, { client: a.client, table: d.identity }, { now: () => 2_000 })).kind, "taken");
    const ledger = await openDynamoSigningLedger(a.client, { table: d.ledger, generation: 1, relayer: { address: RELAYER_ADDRESS }, onFenced: ledgerFencedHook(a.writer), resends: 2 });
    assert.equal((await takeRelayerRole(a.writer, { ledger, now: () => 3_000, timing: TIMING })).kind, "taken");

    const script = new FaultScript();
    const report = await inspectDeployment(d.target(await freshClient(script), { state: "ok", arn: null, version: null, relayer: RELAYER_ADDRESS }));
    assert.deepEqual(report.findings, [], JSON.stringify(report.findings));
    assert.equal(report.routing.state === "ok" && report.routing.value.primary_pool, "p1");
    assert.deepEqual(report.appgen, { state: "ok", value: { current_generation: 1, matches_configuration: true } });
    assert.deepEqual(report.pools.map((p) => [p.pool, p.named_as, p.item.state === "ok" ? p.item.value.writer_task : p.item.state]), [["p1", ["configured", "primary", "identity-writer", "relayer"], "task-a"]]);
    assert.equal(report.identity_writer.role.state === "ok" && report.identity_writer.role.value.task, "task-a");
    assert.deepEqual(report.identity_writer.holder && [report.identity_writer.holder.holder, report.identity_writer.holder.primary], ["current", true]);
    assert.equal(report.relayer?.consistency, "mirrored");
    assert.deepEqual(report.relayer?.holder && [report.relayer.holder.holder, report.relayer.holder.primary], ["current", true]);
    assert.equal(writesOf(script), 0, "inspection wrote nothing");
  });

  test("after a newer task took the pool: the role holders are SUPERSEDED (lost), said so; a game of the old epoch is superseded and may be taken; open money games are listed with their owner -- nothing written", async () => {
    const d = await deployment("i-superseded");
    await primary(d.game, "p1");
    const a = await writer(d.game, "p1", "task-a");
    assert.equal((await takeIdentityWriterRole(a.writer, { client: a.client, table: d.identity }, { now: () => 2_000 })).kind, "taken");
    const g = await makeGame(d.game, a, 1, 2);
    const money = createDynamoFinancialStore({ client: a.client, table: d.game, fence: a.writer.fence, timing: TIMING });
    assert.equal((await money.create(financial(2))).outcome.kind, "committed");
    await writer(d.game, "p1", "task-b");

    const script = new FaultScript();
    const t = d.target(await freshClient(script));
    const report = await inspectDeployment(t);
    assert.equal(report.identity_writer.holder?.holder, "superseded");
    assert.ok(report.findings.some((f) => /identity writer: held by task-a, but pool p1's current task is task-b/.test(f)), report.findings.join("\n"));

    const game = await inspectGame(t, g);
    assert.equal(game.owner.class, "superseded");
    assert.equal(game.head.state === "ok" && game.head.value.log_next_index, 2);
    assert.deepEqual(game.record.state === "ok" && [game.record.value.record_version, game.record.value.status], [1, "waiting"]);
    assert.equal(game.hold.state, "absent");
    assert.equal(game.financial.state, "absent");
    assert.deepEqual([game.actions.claim.allowed, game.actions.take.allowed, game.actions.release.allowed], [false, true, false]);

    const moneyGame = await inspectGame(t, gameId(2));
    assert.deepEqual(moneyGame.financial.state === "ok" && [moneyGame.financial.value.phase, moneyGame.financial.value.continues_here], ["funding", true]);
    const open = await listGames(t, { money: true });
    assert.deepEqual(open.games.map((x) => [x.game_id, x.owner]), [[gameId(2), "superseded"]]);
    const all = await listGames(t);
    assert.deepEqual(all.games.map((x) => x.game_id), [g], "the directory is written with a record's creation (this money game has only its financial record)");
    assert.deepEqual(all.problems, []);
    assert.equal(writesOf(script), 0);
  });
});

/* ==================================================================
    §2 ABSENT, UNREADABLE, UNAVAILABLE: THREE ANSWERS
   ================================================================== */
describe("§2 absent, unreadable and unavailable are never confused", () => {
  test("nothing there: every item ABSENT, and the findings say what that means (the bootstrap's items are L5-8's)", async () => {
    const d = await deployment("m-absent", { appgen: null });
    const report = await inspectDeployment(d.target(await freshClient(), { state: "ok", arn: null, version: null, relayer: RELAYER_ADDRESS }));
    assert.deepEqual([report.routing.state, report.appgen.state, report.identity_writer.role.state, report.relayer?.mirror.state, report.relayer?.fence.state, report.relayer?.consistency], ["absent", "absent", "absent", "absent", "absent", "none"]);
    assert.ok(report.findings.some((f) => /SYSTEM\/ROUTING does not exist.*L5-8/.test(f)));
    assert.ok(report.findings.some((f) => /no APPGEN.*L5-8/.test(f)));
    const game = await inspectGame(d.target(await freshClient()), gameId(1));
    assert.deepEqual([game.head.state, game.owner.class, game.record.state, game.hold.state, game.financial.state], ["absent", "no-head", "absent", "absent", "absent"]);
  });

  test("damaged or a later build's items are UNREADABLE (with the format), item by item -- never absent, never read as a value", async () => {
    const d = await deployment("m-unreadable", { appgen: null });
    await put(d.game, { ...ROUTING_KEY, fmt: N(1), primary_pool: S("p1"), routing_version: N(1), updated_at: N(1), updated_by: S("x"), claim: S("c"), extra: S("?") });
    await put(d.ledger, { ...LEDGER_KEYS.appgen(), schema: N(2), current_generation: N(1) });
    await put(d.identity, { pk: S("ROLE#identity-writer"), sk: S("ROLE"), garbage: S("x") });
    await put(d.game, { ...relayerRoleKey(RELAYER_ADDRESS), fmt: N(9) });
    await put(d.ledger, { ...LEDGER_KEYS.fence(RELAYER_ADDRESS), schema: N(1), kind: S("relayer-fence"), relayer: S(RELAYER_ADDRESS), epoch: S("1") });
    await put(d.game, { ...poolKey("p1"), writer_epoch: S("1"), writer_task: S("t") });
    const report = await inspectDeployment(d.target(await freshClient(), { state: "ok", arn: null, version: null, relayer: RELAYER_ADDRESS }));
    const format = (read: { state: string; format?: string }) => `${read.state}${read.format !== undefined ? `/${read.format}` : ""}`;
    assert.equal(format(report.routing), "unreadable/corrupt");
    assert.equal(format(report.appgen), "unreadable/newer", "a later schema's APPGEN");
    assert.equal(format(report.identity_writer.role), "unreadable/corrupt");
    assert.equal(format(report.relayer!.mirror), "unreadable/corrupt");
    assert.equal(format(report.relayer!.fence), "unreadable/corrupt");
    assert.equal(report.relayer!.consistency, "unknown");
    assert.equal(format(report.pools.find((p) => p.pool === "p1")!.item), "unreadable/corrupt");

    /* A game: a HEAD with an attribute this build never writes is a later build's (never acted on); a record of a later
       schema, a damaged financial record and a damaged hold are each unreadable. */
    const g = gameId(3);
    await put(d.game, { ...headKey(g), owner_pool: S("p1"), pool_epoch: N(1), log_next_index: N(0), log_bytes: N(0), claim_gen: N(4) });
    await put(d.game, { pk: S(gamePk(g)), sk: S("META"), body: S(JSON.stringify({ ...gameRecord(3), record_schema: 3 })), record_version: N(1) });
    await put(d.game, { pk: S(gamePk(g)), sk: S("FIN"), body: S("{broken"), record_version: N(1) });
    await put(d.game, { pk: S(gamePk(g)), sk: S("HOLD"), body: S("{}") });
    const game = await inspectGame(d.target(await freshClient()), g);
    assert.equal(format(game.head), "unreadable/newer");
    assert.equal(game.owner.class, "unknown");
    assert.equal(format(game.record), "unreadable/newer");
    assert.equal(format(game.financial), "unreadable/corrupt");
    assert.equal(format(game.hold), "unreadable/corrupt");
    assert.deepEqual([game.actions.claim.allowed, game.actions.take.allowed, game.actions.release.allowed], [false, false, false]);
  });

  test("a read that FAILS is UNAVAILABLE -- never absent, never unreadable", async () => {
    const d = await deployment("m-unavailable");
    await primary(d.game, "p1");
    const script = new FaultScript();
    for (let nth = 1; nth <= 12; nth += 1) script.add({ op: "GetItemCommand", nth, action: { kind: "fail" } });
    const report = await inspectDeployment(d.target(await freshClient(script), { state: "ok", arn: null, version: null, relayer: RELAYER_ADDRESS }));
    assert.deepEqual([report.routing.state, report.appgen.state, report.identity_writer.role.state, report.relayer?.mirror.state, report.relayer?.fence.state], ["unavailable", "unavailable", "unavailable", "unavailable", "unavailable"]);
  });
});

/* ==================================================================
    §3 THE ROUTING COMPARE-AND-SWAP
   ================================================================== */
describe("§3 set-primary: the routing CAS", () => {
  async function flipDeployment(label: string) {
    const d = await deployment(label);
    await primary(d.game, "p1");
    await writer(d.game, "p1", "task-a");
    await writer(d.game, "p2", "task-c");
    return d;
  }

  test("a dry run writes NOTHING; applied: the routing moves to exactly version + 1, written by this run, its evidence first and its result after", async () => {
    const d = await flipDeployment("r-apply");
    const script = new FaultScript();
    const t = d.target(await freshClient(script));
    const dry = await setPrimary(context(t), { pool: "p2", expectVersion: 1, note: "flip to p2", apply: false });
    expectKind(dry, "planned");
    assert.equal(writesOf(script), 0, "a dry run writes nothing -- not even the run's evidence");
    assert.equal((await readRouting(admin, d.game))?.primary_pool, "p1");
    const audits: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const applied = await setPrimary(context(t, audits), { pool: "p2", expectVersion: 1, note: "flip to p2", apply: true });
    expectKind(applied, "applied");
    const routing = await readRouting(admin, d.game);
    assert.deepEqual([routing?.primary_pool, routing?.routing_version, routing?.updated_by], ["p2", 2, `gamesDoctor/${runOf(applied)}`]);
    const evidence = await raw(d.game, oprunKey(runOf(applied)));
    assert.deepEqual([evidence?.command?.S, evidence?.subject?.S, evidence?.note?.S], ["set-primary", "SYSTEM/ROUTING -> p2", "flip to p2"]);
    assert.equal((await raw(d.game, oprunResultKey(runOf(applied))))?.outcome?.S, "applied");
    assert.equal(audits.length, 1);
    assert.deepEqual([audits[0].event, audits[0].fields.outcome, (audits[0].fields.after as { routing_version: number }).routing_version], ["operator.set-primary", "applied", 2]);
    /* The order: the evidence Put before the routing Put. */
    const puts = script.calls.filter((call) => call.op === "PutItemCommand").map((call) => (call.detail.includes('"OPRUN"') ? "evidence" : call.detail.includes('"ROUTING"') ? "routing" : call.detail.includes('"RESULT"') ? "result" : "other"));
    assert.deepEqual(puts, ["evidence", "routing", "result"]);
  });

  test("a stale --expect-version is refused before anything is written; the first routing, an op: pool, a pool no task took, the current primary: refused, nothing written", async () => {
    const d = await flipDeployment("r-refuse");
    const script = new FaultScript();
    const t = d.target(await freshClient(script));
    const stale = await setPrimary(context(t), { pool: "p2", expectVersion: 7, note: "n", apply: true });
    expectKind(stale, "refused");
    assert.match((stale as { reason: string }).reason, /routing is at version 1 .*not --expect-version 7/);
    expectKind(await setPrimary(context(t), { pool: "op:r-0123456789abcdef", expectVersion: 1, note: "n", apply: true }), "refused");
    const missing = await setPrimary(context(t), { pool: "p9", expectVersion: 1, note: "n", apply: true });
    assert.match((missing as { reason: string }).reason, /no pool item: no task of it has ever started/);
    expectKind(await setPrimary(context(t), { pool: "p1", expectVersion: 1, note: "n", apply: true }), "refused");
    expectKind(await setPrimary(context(t), { pool: "p2", expectVersion: 1, note: "", apply: true }), "refused");
    assert.equal(writesOf(script), 0);
    const empty = await deployment("r-first");
    await writer(empty.game, "p2", "task-c");
    const firstScript = new FaultScript();
    const first = await setPrimary(context(empty.target(await freshClient(firstScript))), { pool: "p2", expectVersion: 1, note: "n", apply: true });
    assert.match((first as { reason: string }).reason, /first routing is written by the deployment bootstrap \(L5-8\)/);
    assert.equal(writesOf(firstScript), 0);
    assert.equal(await readRouting(admin, empty.game), null);
  });

  test("an unreadable routing is refused and left byte-identical", async () => {
    const d = await flipDeployment("r-unreadable");
    const damaged = { ...ROUTING_KEY, fmt: N(2), primary_pool: S("p1"), routing_version: N(1), updated_at: N(1), updated_by: S("x"), claim: S("c") };
    await put(d.game, damaged);
    const refused = await setPrimary(context(d.target(await freshClient())), { pool: "p2", expectVersion: 1, note: "n", apply: true });
    assert.match((refused as { reason: string }).reason, /unreadable .*never written over/);
    assert.deepEqual(await raw(d.game, ROUTING_KEY), damaged);
  });

  test("a CONCURRENT change between the tool's read and its write is never overwritten: the tool's CAS is refused, the other change stands", async () => {
    const d = await flipDeployment("r-race");
    await writer(d.game, "p3", "task-d");
    const hold = gate();
    const script = new FaultScript([{ op: "PutItemCommand", where: (detail) => detail.includes('"ROUTING"'), action: { kind: "stall", gate: hold } }]);
    const pending = setPrimary(context(d.target(await freshClient(script))), { pool: "p2", expectVersion: 1, note: "flip", apply: true });
    await hold.reached;
    assert.equal((await setPrimaryPool(admin, d.game, { pool: "p3", expectedVersion: 1, by: "pipeline", now: 2 })).kind, "set", "another change lands first");
    hold.release();
    const result = await pending;
    expectKind(result, "conflict");
    assert.match((result as { detail: string }).detail, /now version 2, primary p3, set by pipeline/);
    const routing = await readRouting(admin, d.game);
    assert.deepEqual([routing?.primary_pool, routing?.routing_version, routing?.updated_by], ["p3", 2, "pipeline"], "the concurrent change stands");
    assert.equal((await raw(d.game, oprunResultKey(runOf(result))))?.outcome?.S, "conflict");
  });

  test("a LOST answer is settled by the claim (applied); an UNKNOWN one is reported as such, and the re-run can never move the routing twice", async () => {
    const d = await flipDeployment("r-lost");
    const lost = new FaultScript([{ op: "PutItemCommand", where: (detail) => detail.includes('"ROUTING"'), action: { kind: "lose-answer" } }]);
    const settled = await setPrimary(context(d.target(await freshClient(lost))), { pool: "p2", expectVersion: 1, note: "flip", apply: true });
    expectKind(settled, "applied");
    assert.deepEqual(lost.unfired(), [], "the answer was lost");
    assert.equal((await readRouting(admin, d.game))?.routing_version, 2);

    const e = await flipDeployment("r-unknown");
    const unknown = new FaultScript([
      { op: "PutItemCommand", where: (detail) => detail.includes('"ROUTING"'), action: { kind: "lose-answer" } },
      /* The settling read fails too: nothing can be said. (The plan's and setPrimaryPool's own reads come first.) */
      { op: "GetItemCommand", where: (detail) => detail.includes('"ROUTING"'), nth: 3, action: { kind: "fail" } },
    ]);
    const result = await setPrimary(context(e.target(await freshClient(unknown))), { pool: "p2", expectVersion: 1, note: "flip", apply: true });
    expectKind(result, "unknown");
    assert.match((result as { detail: string }).detail, /run the same command again with --expect-version 1: it can never move the routing twice/);
    assert.deepEqual(unknown.unfired(), []);
    /* It had landed. The re-run with the SAME expectation is refused -- the routing moved once, by the first run. */
    const again = await setPrimary(context(e.target(await freshClient())), { pool: "p2", expectVersion: 1, note: "flip", apply: true });
    expectKind(again, "refused");
    assert.match((again as { reason: string }).reason, new RegExp(`version 2 \\(primary p2, set by gamesDoctor/${runOf(result).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
  });
});

/* ==================================================================
    §4 THE OPERATOR'S GAME FENCES: CLAIM, TAKE, RELEASE -- AND THE ABA THEY MUST NOT OPEN
   ================================================================== */
describe("§4 claim / take / release", () => {
  test("a RELEASED game: claimed by a run (the pool is routed away, its writes refused), released by that run, claimed back by the pool; dry runs write nothing", async () => {
    const d = await deployment("g-claim");
    const a = await writer(d.game, "p1", "task-a");
    const g = await makeGame(d.game, a, 10);
    assert.equal(await releaseGame(a.client, d.game, g, a.writer.fence), true);
    const script = new FaultScript();
    const t = d.target(await freshClient(script));
    expectKind(await claimGameAsOperator(context(t), { gameId: g, note: "review", apply: false }), "planned");
    assert.equal(writesOf(script), 0);
    const claimed = await claimGameAsOperator(context(t), { gameId: g, note: "review", apply: true });
    expectKind(claimed, "applied");
    const run = runOf(claimed);
    assert.deepEqual([(await readHead(admin, d.game, g))?.owner_pool, (await readHead(admin, d.game, g))?.pool_epoch], [run, 1]);
    assert.equal((await claimGame(a.client, d.game, g, { ...a.writer.fence, task: "task-a" }, TIMING)).kind, "owned-elsewhere", "the pool is routed away");
    assert.equal(fenceScopeOf(await createDynamoLogStore({ client: a.client, table: d.game, fence: a.writer.fence, timing: TIMING }).appendBatch(g, entries(1, 1))), "game");
    expectKind(await releaseGameAsOperator(context(t), { gameId: g, run: "op:r-ffffffffffffffff", note: "done", apply: true }), "refused");
    const before = writesOf(script);
    expectKind(await releaseGameAsOperator(context(t), { gameId: g, run, note: "done", apply: false }), "planned");
    assert.equal(writesOf(script), before, "a dry-run release writes nothing");
    expectKind(await releaseGameAsOperator(context(t), { gameId: g, run, note: "done", apply: true }), "applied");
    assert.equal((await readHead(admin, d.game, g))?.owner_pool, NO_OWNER);
    assert.equal((await claimGame(a.client, d.game, g, { ...a.writer.fence, task: "task-a" }, TIMING)).kind, "claimed");
    assert.equal(await logCount(d.game, g), 1);
  });

  test("a SUPERSEDED owner is taken: requests of the displaced task delayed across the take, the release and the pool's reclaim are ALL refused by their own fence (no ABA) -- and it can never claim again", async () => {
    const d = await deployment("g-take");
    const a = await writer(d.game, "p1", "task-a");
    const g = await makeGame(d.game, a, 20);
    const aLog = createDynamoLogStore({ client: a.client, table: d.game, fence: a.writer.fence, timing: TIMING });
    await aLog.loadLog(g); // validated: the next append goes straight to its transaction
    const b = await writer(d.game, "p1", "task-b"); // A is now superseded; B has not claimed g yet
    /* Two requests of A, each delayed on its way (stalled before the service sees it). */
    const early = gate();
    const late = gate();
    a.script.add({ op: TWI, where: (detail) => detail.includes(g), action: { kind: "stall", gate: early } });
    const first = aLog.appendBatch(g, entries(1, 1, "straggler-1"));
    await early.reached;
    const t = d.target(await freshClient());
    const taken = await takeGameAsOperator(context(t), { gameId: g, note: "stuck on a dead epoch", apply: true });
    expectKind(taken, "applied");
    const run = runOf(taken);
    expectKind(await releaseGameAsOperator(context(t), { gameId: g, run, note: "hand back", apply: true }), "applied");
    /* Released, nobody has claimed it: the first straggler arrives -- refused (the HEAD names no owner). */
    early.release();
    assert.equal(fenceScopeOf(await first), "game");
    /* A cannot claim it back: its pool fence is false forever. */
    assert.equal((await claimGame(a.client, d.game, g, { ...a.writer.fence, task: "task-a" }, TIMING)).kind, "stale-pool");
    /* The pool's current task claims it; a second delayed request of A arrives after that -- refused too. */
    a.script.add({ op: TWI, where: (detail) => detail.includes(g), action: { kind: "stall", gate: late } });
    const second = aLog.appendBatch(g, entries(1, 1, "straggler-2"));
    await late.reached;
    assert.equal((await claimGame(b.client, d.game, g, { ...b.writer.fence, task: "task-b" }, TIMING)).kind, "claimed");
    late.release();
    assert.equal(fenceScopeOf(await second), "game");
    assert.equal(await logCount(d.game, g), 1, "no write of the displaced task landed");
    const bLog = createDynamoLogStore({ client: b.client, table: d.game, fence: b.writer.fence, timing: TIMING });
    assert.equal((await bLog.loadLog(g)).length, 1);
    assert.equal((await bLog.appendBatch(g, entries(1, 1, "b"))).kind, "committed", "the pool continues exactly where it loaded");
  });

  test("NEGATIVE CONTROL -- why the live-owner take is stopped: a naive operator hold on a CURRENT owner, released, lets the same (pool, epoch) claim back, and a request of it delayed across the hold LANDS under that recurring fence", async () => {
    const d = await deployment("g-aba");
    const a = await writer(d.game, "p1", "task-a");
    const g = await makeGame(d.game, a, 30);
    const aLog = createDynamoLogStore({ client: a.client, table: d.game, fence: a.writer.fence, timing: TIMING });
    await aLog.loadLog(g);
    /* The tool refuses it, and writes nothing. */
    const script = new FaultScript();
    const refused = await takeGameAsOperator(context(d.target(await freshClient(script))), { gameId: g, note: "live owner", apply: true });
    expectKind(refused, "refused");
    assert.equal((refused as { reason: string }).reason, LIVE_OWNER_TAKE_STOPPED);
    assert.equal(writesOf(script), 0);
    /* What a naive take would do (today's fence cannot tell the reclaimed (P, E) from the displaced one): */
    const delayed = gate();
    a.script.add({ op: TWI, where: (detail) => detail.includes(g), action: { kind: "stall", gate: delayed } });
    const straggler = aLog.appendBatch(g, entries(1, 1, "sent-before-the-hold"));
    await delayed.reached;
    await admin.send(new UpdateItemCommand({ TableName: d.game, Key: headKey(g), UpdateExpression: "SET owner_pool = :op, pool_epoch = :one", ExpressionAttributeValues: { ":op": S("op:naive"), ":one": N(1) } }), { abortSignal: deadline() });
    await admin.send(new UpdateItemCommand({ TableName: d.game, Key: headKey(g), UpdateExpression: "SET owner_pool = :none", ExpressionAttributeValues: { ":none": S(NO_OWNER) } }), { abortSignal: deadline() });
    assert.equal((await claimGame(a.client, d.game, g, { ...a.writer.fence, task: "task-a" }, TIMING)).kind, "claimed", "the same (P, E) claims it back: its pool fence still holds");
    delayed.release();
    assert.equal((await straggler).kind, "committed", "the delayed request LANDED across the hold: the ABA the stop avoids");
  });

  test("races between the tool's read and its write: a pool's claim first -> the take is refused and the claim stands; the take first -> the pool is routed away", async () => {
    const d = await deployment("g-race");
    const a = await writer(d.game, "p1", "task-a");
    const g1 = await makeGame(d.game, a, 40);
    const g2 = await makeGame(d.game, a, 41);
    const b = await writer(d.game, "p1", "task-b");
    const hold = gate();
    const script = new FaultScript([{ op: TWI, where: (detail) => detail.includes(g1) && detail.includes("owner_pool"), action: { kind: "stall", gate: hold } }]);
    const pending = takeGameAsOperator(context(d.target(await freshClient(script))), { gameId: g1, note: "race", apply: true });
    await hold.reached;
    assert.equal((await claimGame(b.client, d.game, g1, { ...b.writer.fence, task: "task-b" }, TIMING)).kind, "claimed");
    hold.release();
    const result = await pending;
    expectKind(result, "conflict");
    assert.match((result as { detail: string }).detail, /the HEAD changed since it was read/);
    assert.deepEqual([(await readHead(admin, d.game, g1))?.owner_pool, (await readHead(admin, d.game, g1))?.pool_epoch], ["p1", 2], "the pool's claim stands");
    expectKind(await takeGameAsOperator(context(d.target(await freshClient())), { gameId: g2, note: "race", apply: true }), "applied");
    assert.equal((await claimGame(b.client, d.game, g2, { ...b.writer.fence, task: "task-b" }, TIMING)).kind, "owned-elsewhere");
    /* The owner's pool moved in between (a newer task): still superseded, and the in-write proof holds. The pool item
       damaged in between: the proof fails -- refused, nothing written over the HEAD. */
    const g3 = await makeGame(d.game, b, 42);
    await writer(d.game, "p1", "task-c");
    const hold2 = gate();
    const script2 = new FaultScript([{ op: TWI, where: (detail) => detail.includes(g3) && detail.includes("owner_pool"), action: { kind: "stall", gate: hold2 } }]);
    const pending2 = takeGameAsOperator(context(d.target(await freshClient(script2))), { gameId: g3, note: "race", apply: true });
    await hold2.reached;
    await put(d.game, { ...poolKey("p1"), writer_epoch: S("3"), writer_task: S("task-c") });
    hold2.release();
    const damaged = await pending2;
    expectKind(damaged, "conflict");
    assert.match((damaged as { detail: string }).detail, /POOL#p1 is no longer ahead/);
    assert.deepEqual([(await readHead(admin, d.game, g3))?.owner_pool, (await readHead(admin, d.game, g3))?.pool_epoch], ["p1", 2]);
  });

  test("a LOST answer is settled (applied, once); no evaluated answer at all is settled DEFINITELY once the run's fence is retired; only when that fence cannot be retired is it UNKNOWN (with how to settle it) -- and a later take still works", async () => {
    const d = await deployment("g-lost");
    const a = await writer(d.game, "p1", "task-a");
    const g1 = await makeGame(d.game, a, 50);
    const g2 = await makeGame(d.game, a, 51);
    const g3 = await makeGame(d.game, a, 52);
    const g4 = await makeGame(d.game, a, 53);
    await writer(d.game, "p1", "task-b");
    const lost = new FaultScript([{ op: TWI, where: (detail) => detail.includes(g1), action: { kind: "lose-answer" } }]);
    const settled = await takeGameAsOperator(context(d.target(await freshClient(lost))), { gameId: g1, note: "lost", apply: true });
    expectKind(settled, "applied");
    assert.deepEqual(lost.unfired(), [], "the answer was lost");
    assert.match((settled as { detail: string }).detail, /settled/);
    assert.equal((await readHead(admin, d.game, g1))?.owner_pool, runOf(settled));
    /* Re-review: the claim LANDED, its answer was lost (and no resend was evaluated), and the hold was released from
       another console before this run read the HEAD: still "applied" -- only this run's claim writes this run's task. */
    const retireReached = gate();
    const quick = new FaultScript([
      { op: TWI, where: (detail) => detail.includes(g4), nth: 1, action: { kind: "lose-answer" } },
      { op: TWI, where: (detail) => detail.includes(g4), nth: 2, action: { kind: "fail", code: "TimeoutError" } },
      { op: TWI, where: (detail) => detail.includes(g4), nth: 3, action: { kind: "fail", code: "TimeoutError" } },
      { op: "UpdateItemCommand", where: (detail) => detail.includes("-retired"), action: { kind: "stall", gate: retireReached } },
    ]);
    const pending = takeGameAsOperator(context(d.target(await freshClient(quick))), { gameId: g4, note: "lost then released", apply: true });
    await retireReached.reached;
    const holder = (await readHead(admin, d.game, g4))?.owner_pool ?? "";
    expectKind(await releaseGameAsOperator(context(d.target(await freshClient())), { gameId: g4, run: holder, note: "other console", apply: true }), "applied");
    retireReached.release();
    const releasedEarly = await pending;
    expectKind(releasedEarly, "applied");
    assert.match((releasedEarly as { detail: string }).detail, /has since been released/);
    assert.deepEqual(quick.unfired(), []);
    const failEveryTake = (g: string) => [1, 2, 3].map((nth) => ({ op: TWI, where: (detail: string) => detail.includes(g), nth, action: { kind: "fail" as const, code: "TimeoutError" } }));
    const never = new FaultScript(failEveryTake(g2));
    const definite = await takeGameAsOperator(context(d.target(await freshClient(never))), { gameId: g2, note: "no answer", apply: true });
    expectKind(definite, "conflict");
    assert.match((definite as { detail: string }).detail, /did not land and never can/);
    assert.deepEqual(never.unfired(), []);
    /* The run's fence cannot be retired either (its later moves throttled): then, and only then, UNKNOWN. */
    const stuck = new FaultScript([...failEveryTake(g3), ...[2, 3, 4].map((nth) => ({ op: "UpdateItemCommand", where: (detail: string) => detail.includes("POOL#op:"), nth, action: { kind: "fail" as const } }))]);
    const unknown = await takeGameAsOperator(context(d.target(await freshClient(stuck))), { gameId: g3, note: "unknown", apply: true });
    expectKind(unknown, "unknown");
    assert.match((unknown as { detail: string }).detail, /could NOT be retired/);
    assert.deepEqual(stuck.unfired(), []);
    assert.equal((await readHead(admin, d.game, g3))?.owner_pool, "p1");
    expectKind(await takeGameAsOperator(context(d.target(await freshClient())), { gameId: g2, note: "again", apply: true }), "applied");
    expectKind(await takeGameAsOperator(context(d.target(await freshClient())), { gameId: g3, note: "again", apply: true }), "applied");
  });

  test("review M1: the run's fence is RETIRED once its claim has an answer -- a copy of the operator's own claim (a lost original, or one delayed past the token window) can never land later, even when the released HEAD recurs exactly", async () => {
    const d = await deployment("g-retire");
    const a = await writer(d.game, "p1", "task-a");
    const g1 = await makeGame(d.game, a, 55);
    const g2 = await makeGame(d.game, a, 56);
    const aFence = { ...a.writer.fence, task: "task-a" };
    for (const g of [g1, g2]) {
      assert.equal((await claimGame(a.client, d.game, g, aFence, TIMING)).kind, "claimed"); // owner_task = task-a
      assert.equal(await releaseGame(a.client, d.game, g, a.writer.fence), true); // (#none, 1, task-a)
    }
    const sent = (script: FaultScript, g: string): TransactWriteItem[] => {
      const call = script.calls.find((c) => c.op === TWI && c.detail.includes(g));
      assert.ok(call !== undefined, "the claim's transaction was seen");
      return (JSON.parse(call.detail) as { TransactItems: TransactWriteItem[] }).TransactItems;
    };
    const replay = (items: TransactWriteItem[]) => admin.send(new TransactWriteItemsCommand({ TransactItems: items }), { abortSignal: deadline() });
    /* 1. No evaluated answer at all: after the retirement the HEAD settles it DEFINITELY (not landed, never can). */
    const unknown = new FaultScript([1, 2, 3].map((nth) => ({ op: TWI, where: (detail: string) => detail.includes(g1), nth, action: { kind: "fail" as const, code: "TimeoutError" } })));
    const lost = await claimGameAsOperator(context(d.target(await freshClient(unknown))), { gameId: g1, note: "lost", apply: true });
    expectKind(lost, "conflict");
    assert.match((lost as { detail: string }).detail, /fence is retired .* did not land and never can/);
    assert.equal((await raw(d.game, poolKey(runOf(lost))))?.writer_epoch?.N, "2", "the run's fence moved past 1");
    /* The released HEAD recurs exactly (the pool claims and releases it again); the late original then arrives: refused. */
    assert.equal((await claimGame(a.client, d.game, g1, aFence, TIMING)).kind, "claimed");
    assert.equal(await releaseGame(a.client, d.game, g1, a.writer.fence), true);
    await assert.rejects(replay(sent(unknown, g1)), (error: Error) => error.name === "TransactionCanceledException");
    assert.equal((await readHead(admin, d.game, g1))?.owner_pool, NO_OWNER, "the operator's late claim never landed");
    /* 2. Applied, released by the run, the pool reclaims and re-releases; a copy of the applied claim evaluated afresh
          (as one delayed past the token's window would be): refused. */
    const script = new FaultScript();
    const applied = await claimGameAsOperator(context(d.target(await freshClient(script))), { gameId: g2, note: "hold", apply: true });
    expectKind(applied, "applied");
    expectKind(await releaseGameAsOperator(context(d.target(await freshClient())), { gameId: g2, run: runOf(applied), note: "done", apply: true }), "applied");
    assert.equal((await claimGame(a.client, d.game, g2, aFence, TIMING)).kind, "claimed");
    assert.equal(await releaseGame(a.client, d.game, g2, a.writer.fence), true);
    await assert.rejects(replay(sent(script, g2)), (error: Error) => error.name === "TransactionCanceledException");
    assert.equal((await readHead(admin, d.game, g2))?.owner_pool, NO_OWNER);
  });

  test("the evidence is written FIRST: when it cannot be, nothing is changed -- no run pool, no HEAD change", async () => {
    const d = await deployment("g-evidence");
    const a = await writer(d.game, "p1", "task-a");
    const g = await makeGame(d.game, a, 60);
    await writer(d.game, "p1", "task-b");
    const script = new FaultScript([{ op: "PutItemCommand", where: (detail) => detail.includes('"OPRUN"'), action: { kind: "fail" } }]);
    const run = { run: "op:r-00000000000000aa", task: "gamesDoctor-00000000000000aa" };
    const result = await takeGameAsOperator({ ...context(d.target(await freshClient(script))), newRun: () => run }, { gameId: g, note: "no evidence", apply: true });
    expectKind(result, "refused");
    assert.match((result as { reason: string }).reason, /evidence item .* could not be written/);
    assert.equal(await raw(d.game, poolKey(run.run)), null, "no run pool");
    assert.deepEqual([(await readHead(admin, d.game, g))?.owner_pool, (await readHead(admin, d.game, g))?.pool_epoch], ["p1", 1]);
    assert.equal(script.count(TWI) + script.count("UpdateItemCommand"), 0);
  });

  test("anything not fully understood is refused with nothing written: a HEAD with an attribute this build never writes; an owner pool item with one", async () => {
    const d = await deployment("g-strict");
    const a = await writer(d.game, "p1", "task-a");
    const g1 = await makeGame(d.game, a, 70);
    const g2 = await makeGame(d.game, a, 71);
    await writer(d.game, "p1", "task-b");
    await admin.send(new UpdateItemCommand({ TableName: d.game, Key: headKey(g1), UpdateExpression: "SET claim_gen = :g", ExpressionAttributeValues: { ":g": N(1) } }), { abortSignal: deadline() });
    const script = new FaultScript();
    const t = d.target(await freshClient(script));
    const newer = await takeGameAsOperator(context(t), { gameId: g1, note: "n", apply: true });
    assert.match((newer as { reason: string }).reason, /unreadable \(newer\)/);
    await admin.send(new UpdateItemCommand({ TableName: d.game, Key: poolKey("p1"), UpdateExpression: "SET #s = :s", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":s": S("retired") } }), { abortSignal: deadline() });
    const pool = await takeGameAsOperator(context(t), { gameId: g2, note: "n", apply: true });
    assert.match((pool as { reason: string }).reason, /carries \[status\], which this build never writes/);
    assert.equal(writesOf(script), 0);
  });
});

/* ==================================================================
    §5 THE CLI END TO END
   ================================================================== */
describe("§5 the CLI", () => {
  test("take / release through `gamesDoctor aws` over DynamoDB Local: the answer on stdout, the AUDIT line on stderr, JSON, exit codes -- and no secret anywhere", async () => {
    const d = await deployment("cli");
    await primary(d.game, "p1");
    const a = await writer(d.game, "p1", "task-a");
    const g = await makeGame(d.game, a, 80);
    await writer(d.game, "p1", "task-b");
    const secrets = { AWS_ACCESS_KEY_ID: "AKIAHOSTILEHOSTILE00", AWS_SECRET_ACCESS_KEY: "hostile-secret-value-do-not-print" };
    const env = { GS_DYNAMODB_LOCAL_ENDPOINT: TARGET.endpoint, ...secrets };
    const seams = { readFile: async () => d.document, clientFor: () => createDynamoDbClient(TARGET), timing: TIMING };
    const run = async (argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runAwsOperator([...argv, "--local-document", "doc.json"], env, { out: (l) => out.push(l), err: (l) => err.push(l) }, seams);
      const text = [...out, ...err].join("\n");
      for (const value of Object.values(secrets)) assert.ok(!text.includes(value), "no credential value is printed");
      return { code, out, err };
    };
    /* Review L2: an option's value is never another option -- `--note --apply` is a usage error, nothing applied. */
    const noNote = await run(["take", g, "--note", "--apply"]);
    assert.equal(noNote.code, EXIT.usage);
    assert.match(noNote.err.join("\n"), /--note needs a value/);
    assert.equal((await readHead(admin, d.game, g))?.owner_pool, "p1");
    const status = await run(["status"]);
    assert.equal(status.code, EXIT.findings, status.out.join("\n"));
    assert.match(status.out.join("\n"), /SYSTEM\/ROUTING {4}primary p1, version 1/);
    const dry = await run(["take", g, "--note", "moving it"]);
    assert.equal(dry.code, EXIT.ok);
    assert.match(dry.out.join("\n"), /DRY RUN: nothing was written/);
    assert.deepEqual(dry.err, []);
    const applied = await run(["take", g, "--note", "moving it", "--apply", "--json"]);
    assert.equal(applied.code, EXIT.ok);
    const result = JSON.parse(applied.out.join("\n")) as { kind: string; run: string };
    assert.equal(result.kind, "applied");
    assert.equal(applied.err.length, 1);
    assert.match(applied.err[0], /^AUDIT \{/);
    const audit = JSON.parse(applied.err[0].slice("AUDIT ".length)) as Record<string, unknown>;
    assert.deepEqual([audit.event, audit.outcome, audit.run, audit.subject, audit.note, audit.tool], ["operator.take", "applied", result.run, g, "moving it", "gamesDoctor"]);
    const game = await run(["game", g, "--json"]);
    assert.equal((JSON.parse(game.out.join("\n")) as { owner: { class: string } }).owner.class, "operator");
    assert.equal(game.code, EXIT.findings, "a game an operator holds is reported");
    const release = await run(["release", g, "--run", result.run, "--note", "done", "--apply"]);
    assert.equal(release.code, EXIT.ok);
    assert.match(release.out.join("\n"), /APPLIED by run op:r-/);
    const refused = await run(["take", g, "--note", "again", "--apply"]);
    assert.equal(refused.code, EXIT.findings);
    assert.match(refused.out.join("\n"), /REFUSED: released: use `claim`/);
  });
});
