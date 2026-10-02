// server/src/persistence/conformance/l6FinalConvergence.dynamoLocal.test.ts
//
// ==================================================================
//  LIVE-6 FINAL CONVERGENCE ON DYNAMODB LOCAL: THE STAGING CERTIFICATION'S BINDING OVER REAL L6-4 ITEMS, THE TASK#
//  HEARTBEAT READER OVER REAL L6-5A ITEMS, AND THE GATES' REAL RECORDS
// ==================================================================
//
// Runs ONLY against a DynamoDB Local named by GS_DYNAMODB_LOCAL_ENDPOINT (`npm run test:dynamodb-local`). What must hold:
//   §1 `tools/awsDeploy.ts`'s `STAGING_RECOVERY_READERS` -- L6-4's own readers and startup rule -- read what L6-4's own
//      writers wrote: a bootstrap table passes the generation gate, an ADOPTED restore passes with its APPGEN#HISTORY
//      claim, an unadopted twin is refused by L6-4's rule; the identity table's TABLE#identity binding and REVIEW#
//      records come through the reviewed safe summary only;
//   §2 the generation gate's REAL `--record` output binds certification only together with the ledger's own
//      APPGEN#HISTORY (a hand-edited claim is refused);
//   §3 the TASK# reader (`STAGING_HEARTBEATS`): the PREVIOUS generation's table, strongly consistent, every page, strictly
//      decoded -- a fresh old-generation heartbeat after the stop is reported, an older one or another generation's is
//      not, a damaged item or an unreadable table THROWS (never "no heartbeat"); it writes nothing.
//   §4 LIVE-6 relayer rotation: `STAGING_ROTATION_READERS` read what the runtime's own writers wrote -- the pool writer's
//      takeover, L5-6's relayer takeover (the ledger's mint, then the game-table mirror), L6-5A's TASK# writer -- and the
//      post-rotation proof PASSES on exactly that; a newer task of the pool (the holder superseded), a damaged heartbeat
//      or old-address work FAILS it; the readers write nothing.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CreateTableCommand, DeleteTableCommand, GetItemCommand, PutItemCommand, ScanCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createDynamoDbClient, deadline, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../../aws/awsClients";
import { runDeployCommand, EXIT_OK, type DeployDeps } from "../../aws/deploy/commands";
import { judgeGenerationGateRecord } from "../../aws/deploy/staging/drills";
import { judgeGeneration, judgeIdentityRecovery, judgeReviews, readGenerationEvidence, readIdentityRecovery, readRestoreHeartbeats, RESTORE_STOP_DIR } from "../../aws/deploy/staging/recovery";
import { bootstrapGenerationMarker, generationMarkerItem, prepareRestoredTable } from "../../aws/game/generationMarker";
import { identityServingChecks, takeOverIdentityWriter } from "../../aws/identity/dynamoIdentityStore";
import { reviewItem } from "../../aws/identity/identityItems";
import { adoptGeneration } from "../../aws/ledger/appGeneration";
import { LEDGER_KEYS } from "../../aws/ledger/dynamoSigningLedger";
import { preparedMarkerCheck } from "../../aws/recovery/recoveryOps";
import { oldGenerationHeartbeatsAfter } from "../../aws/runtime/taskHeartbeats";
import { dynamoTaskStatusWriter, type TaskStatus } from "../../aws/runtime/taskStatus";
import type { ParameterSource } from "../../aws/runtime/configSource";
import { STAGING_HEARTBEATS, STAGING_RECOVERY_READERS, STAGING_ROTATION_READERS } from "../../tools/awsDeploy";
import { setPrimaryPool } from "../../aws/game/routing";
import { openDynamoSigningLedger } from "../../aws/ledger/dynamoSigningLedger";
import { PoolWriter } from "../../aws/ownership/poolWriter";
import { ledgerFencedHook, takeRelayerRole } from "../../aws/ownership/relayerRole";
import { parseJunoBackendConfig } from "../../escrow/juno/junoConfig";
import { addressOfPublicKey } from "../../escrow/juno/cosmosTx";
import { publicKeyOf } from "../../escrow/juno/secp256k1";
import { deploymentIdentityOf } from "../../aws/deploy/junoChain";
import { collectRotationProof, judgeRotationProof } from "../../aws/deploy/staging/rotationProof";
import { fakeJunoChain } from "../../aws/deploy/staging/rotationTestSupport";
import { ConformanceTables, newRunId, requireLocal } from "./dynamoLocal";

const target = dynamoLocalTargetFromEnv();
if (target === null) {
  throw new Error(
    `${DYNAMODB_LOCAL_ENV} is not set. Start DynamoDB Local on this machine and point the suite at it, e.g.\n` +
      `  docker run --rm -p 127.0.0.1:8000:8000 amazon/dynamodb-local:3.3.1 -jar DynamoDBLocal.jar -inMemory\n` +
      `  ${DYNAMODB_LOCAL_ENV}=http://127.0.0.1:8000 npm run test:dynamodb-local\n`,
  );
}
const TARGET = target;
const admin: DynamoDBClient = createDynamoDbClient(TARGET);
const tables = new ConformanceTables(admin, newRunId());
const named: string[] = [];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gs-l6final-"));

after(async () => {
  for (const name of named) await admin.send(new DeleteTableCommand({ TableName: name }), { abortSignal: deadline() });
  await tables.dropAll();
  assert.deepEqual(tables.live, [], "every table this run made was dropped");
  fs.rmSync(scratch, { recursive: true, force: true });
  admin.destroy();
});

type Item = Record<string, AttributeValue>;
const N = (value: number): AttributeValue => ({ N: String(value) });
const S = (value: string): AttributeValue => ({ S: value });
const noSleep = async () => undefined;
const put = (table: string, item: Item) => admin.send(new PutItemCommand({ TableName: table, Item: item }), { abortSignal: deadline() });
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
const snapshot = async (table: string) => JSON.stringify((await scanAll(table)).map((i) => JSON.stringify(Object.keys(i).sort().map((k) => [k, i[k]]))).sort());
async function namedTable(name: string): Promise<string> {
  await requireLocal(admin);
  await admin.send(
    new CreateTableCommand({ TableName: name, KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }], AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }], BillingMode: "PAY_PER_REQUEST" }),
    { abortSignal: deadline() },
  );
  named.push(name);
  return name;
}

/** A generation world as L5-8 and L6-4 make it, under the naming convention (so `generation-gate` finds it). */
async function world(options: { readonly adopt: boolean }) {
  const env = `g${Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, "a")}`;
  const logical = { g1: `gs-${env}-game-g1`, g2: `gs-${env}-game-g2` };
  const ledger = await tables.create("final-ledger");
  await put(ledger, { ...LEDGER_KEYS.appgen(), schema: N(1), current_generation: N(1) });
  const g1 = await namedTable(logical.g1);
  await put(g1, generationMarkerItem(bootstrapGenerationMarker({ generation: 1, gameTable: logical.g1, by: "l5-8-bootstrap", now: 1 })));
  const g2 = await namedTable(logical.g2);
  for (const item of await scanAll(g1)) await put(g2, item);
  const restoreId = `r-${env}`;
  assert.equal((await prepareRestoredTable(admin, g2, { gameTable: logical.g2, generation: 2, restoredFrom: { generation: 1, table: logical.g1 }, restorePoint: 1_000, restoreId, by: "op-drill", now: 2_000 })).kind, "prepared");
  if (options.adopt) assert.equal((await adoptGeneration(admin, ledger, { expected: 1, generation: 2, gameTable: logical.g2, restoreId, by: "op-drill" }, preparedMarkerCheck(admin), { now: () => 3_000, sleep: noSleep })).kind, "committed");
  return { env, logical, ledger, g1, g2, restoreId };
}

/* ==================================================================
    §1 THE BINDING OVER L6-4'S OWN ITEMS
   ================================================================== */
describe("§1 STAGING_RECOVERY_READERS: L6-4's own readers and startup rule, over what L6-4's own writers wrote", () => {
  test("bootstrap: generation 1 passes, no history; the adopted restore: generation 2 passes with APPGEN#HISTORY's claim; an unadopted twin: L6-4's rule refuses it", async () => {
    const boot = await world({ adopt: false });
    const bootEvidence = await readGenerationEvidence(STAGING_RECOVERY_READERS, { app: admin, ledger: admin }, { game: boot.g1, ledger: boot.ledger });
    assert.deepEqual(judgeGeneration(bootEvidence, { generation: 1, gameTable: boot.logical.g1, requireRestore: false }).filter((c) => c.status !== "pass"), []);
    assert.equal(bootEvidence.history, null, "a bootstrap APPGEN has no adoption history to read");

    const w = await world({ adopt: true });
    const ev = await readGenerationEvidence(STAGING_RECOVERY_READERS, { app: admin, ledger: admin }, { game: w.g2, ledger: w.ledger });
    assert.deepEqual(judgeGeneration(ev, { generation: 2, gameTable: w.logical.g2, requireRestore: true }).filter((c) => c.status !== "pass"), []);
    assert.ok(ev.history !== null && ev.history !== undefined && ev.history.ok && ev.history.value !== null);
    const appgen = ev.appgen !== null && ev.appgen.ok ? ev.appgen.value : null;
    assert.equal(ev.history.value.claim, appgen?.adoption?.claim, "APPGEN and its history item: one transaction");
    /* The old bootstrap table g1, read after the adoption: L6-4's own startup rule refuses it (APPGEN moved). */
    const stale = await readGenerationEvidence(STAGING_RECOVERY_READERS, { app: admin, ledger: admin }, { game: w.g1, ledger: w.ledger });
    assert.match(judgeGeneration(stale, { generation: 1, gameTable: w.logical.g1, requireRestore: false }).filter((c) => c.status !== "pass").map((c) => c.detail).join("\n"), /L6-4 refuses the start: the ledger's adopted app generation is 2, not this task's 1/);
    /* A twin prepared as generation 2 but never adopted: refused by L6-4's adoptionBindingProblem, through the binding. */
    const twinName = `${w.logical.g2}b`;
    const twin = await namedTable(twinName);
    for (const item of await scanAll(w.g1)) await put(twin, item);
    assert.equal((await prepareRestoredTable(admin, twin, { gameTable: twinName, generation: 2, restoredFrom: { generation: 1, table: w.logical.g1 }, restorePoint: 1_000, restoreId: `${w.restoreId}-twin`, by: "op-drill", now: 2_500 })).kind, "prepared");
    const twinEvidence = await readGenerationEvidence(STAGING_RECOVERY_READERS, { app: admin, ledger: admin }, { game: twin, ledger: w.ledger });
    assert.match(judgeGeneration(twinEvidence, { generation: 2, gameTable: twinName, requireRestore: true }).filter((c) => c.status !== "pass").map((c) => c.detail).join("\n"), /L6-4 refuses the start: the ledger's APPGEN adopted .* not this table/);
  });

  test("identity: TABLE#identity through L6-4's own reader; REVIEW# through the reviewed safe summary only -- an open review FAILS, a resolved one does not", async () => {
    const identity = await tables.create("final-identity");
    const unbound = await readIdentityRecovery(STAGING_RECOVERY_READERS, admin, identity);
    assert.match(judgeIdentityRecovery(unbound, identity).filter((c) => c.status !== "pass").map((c) => c.detail).join("\n"), /no TABLE#identity/, "a table no serving takeover bound");
    await takeOverIdentityWriter(admin, identity, { task: "t-cert", pool: "p1", now: () => 1, checks: identityServingChecks(identity) });
    const served = await readIdentityRecovery(STAGING_RECOVERY_READERS, admin, identity);
    assert.deepEqual(judgeIdentityRecovery(served, identity).filter((c) => c.status !== "pass"), []);
    assert.deepEqual(judgeReviews(served).filter((c) => c.status !== "pass"), []);
    const review = {
      profile_id: "pf_0123456789abcdefghjkmnpqr0",
      principal_id: "pr_0123456789abcdefghjkmnpqr0",
      restore_id: "r-final-drill",
      reason: "unconfirmed-recovery-key-rotation" as const,
      opened_at: 5,
      unconfirmed_events: JSON.stringify(["0f".repeat(16)]),
      confirmed_events: "[]",
      selector_state: "quarantined" as const,
      prior_status: "active" as const,
      resolved_at: null,
    };
    await put(identity, reviewItem(review));
    const open = await readIdentityRecovery(STAGING_RECOVERY_READERS, admin, identity);
    const text = JSON.stringify(open);
    assert.match(judgeReviews(open).filter((c) => c.status !== "pass").map((c) => c.detail).join("\n"), /1 open REVIEW# record\(s\) .* restore r-final-drill: 1/);
    assert.ok(!/pf_|pr_|0f0f0f0f|quarantined/.test(text), `the summary carries no profile, principal, event or selector: ${text}`);
    await put(identity, reviewItem({ ...review, resolved_at: 9 }));
    assert.deepEqual(judgeReviews(await readIdentityRecovery(STAGING_RECOVERY_READERS, admin, identity)).filter((c) => c.status !== "pass"), []);
  });
});

/* ==================================================================
    §2 THE GENERATION GATE'S REAL RECORD, CROSS-CHECKED AGAINST APPGEN#HISTORY
   ================================================================== */
describe("§2 the generation gate's REAL --record output binds certification only with the ledger's APPGEN#HISTORY", () => {
  test("the gate's record + the plan's generation_adoption + the history read through the binding: PASS; a hand-edited claim: FAIL; zero writes", async () => {
    const w = await world({ adopt: true });
    const runtimeArn = `arn:aws:ssm:us-east-1:111111111111:parameter/gs/${w.env}/runtime/p1`;
    const document = JSON.stringify({ format: "18COSMOS/AWS-RUNTIME/v1", environment: w.env, region: "us-east-1", pool: "p1", generation: 1, game_table: w.logical.g1, identity_table: `gs-${w.env}-identity`, ledger_table_arn: `arn:aws:dynamodb:us-east-1:222222222222:table/gs-${w.env}-ledger`, escrow: null });
    const parameters: ParameterSource = {
      async read(arn) {
        if (arn !== runtimeArn) throw new Error(`no such parameter ${arn}`);
        return { value: document, version: 3, arn };
      },
    };
    const lines: string[] = [];
    const deps: DeployDeps = {
      parameters,
      dynamo: () => admin,
      kms: () => {
        throw new Error("no KMS here");
      },
      now: () => 1_790_000_000_000,
      out: (line) => lines.push(line),
      tables: ({ gameTable }) => ({ game: gameTable, identity: "unused", ledger: w.ledger }),
    };
    const before = [await snapshot(w.ledger), await snapshot(w.g2)];
    const dir = fs.mkdtempSync(path.join(scratch, "gen-"));
    assert.equal(await runDeployCommand(["generation-gate", "--runtime-parameter", runtimeArn, "--environment", w.env, "--generation", "2", "--restore-id", w.restoreId, "--record", path.join(dir, "gate-generation.json")], deps), EXIT_OK, lines.join("\n"));
    fs.mkdirSync(path.join(dir, "terraform", "app"), { recursive: true });
    fs.writeFileSync(path.join(dir, "terraform", "app", "plan.json"), JSON.stringify({ variables: { generation_adoption: { value: { generation: 2, game_table: w.logical.g2, restore_id: w.restoreId } } } }));
    const evidence = await readGenerationEvidence(STAGING_RECOVERY_READERS, { app: admin, ledger: admin }, { game: w.g2, ledger: w.ledger });
    const judge = () => judgeGenerationGateRecord(dir, { environment: w.env, generation: 2, gameTable: w.logical.g2, evidence, prerequisiteAt: "2026-10-01T00:00:00.000Z" }).filter((c) => c.status !== "pass");
    /* The real gate stamps its own clock (deps.now); the prerequisite of this certification comes after it. */
    const record = JSON.parse(fs.readFileSync(path.join(dir, "gate-generation.json"), "utf8"));
    assert.equal(record.adoption_claim, evidence.history !== null && evidence.history !== undefined && evidence.history.ok ? evidence.history.value?.claim : "?");
    assert.deepEqual(
      judgeGenerationGateRecord(dir, { environment: w.env, generation: 2, gameTable: w.logical.g2, evidence, prerequisiteAt: new Date(1_790_000_100_000).toISOString() }).filter((c) => c.status !== "pass"),
      [],
    );
    fs.writeFileSync(path.join(dir, "gate-generation.json"), JSON.stringify({ ...record, adoption_claim: "44444444-4444-4444-8444-444444444444" }));
    assert.match(judge().map((c) => c.name).join("\n"), /adoption_claim = APPGEN#HISTORY\/GEN#2/);
    assert.deepEqual([await snapshot(w.ledger), await snapshot(w.g2)], before, "the gate and the cross-check only read");
  });
});

/* ==================================================================
    §3 THE TASK# HEARTBEAT READER
   ================================================================== */
describe("§3 the old generation's TASK# heartbeats after the stop: operator proof, never a lease", () => {
  const status = (task: string, generation: number): TaskStatus => ({ task, pool: "p1", poolEpoch: 3, generation, environment: "staging", build: "b1", role: "primary", phase: "serving", ready: true, reasons: [], relayer: "held", escrow: "active", poolWriterCheckAgeMs: 900, startedAt: 1_000 });

  test("strong, every page, strict: fresh generation-N heartbeats after the stop are reported; older ones, other generations and other items are not; nothing is written", async () => {
    const g1 = await tables.create("final-hb-g1");
    const writer = dynamoTaskStatusWriter({ client: admin, table: g1 });
    const stop = 1_790_000_000_000;
    assert.equal(await writer.write(status("t-old-quiet", 1), 1, stop - 60_000), "written"); // its last word before the stop
    assert.equal(await writer.write(status("t-straggler", 1), 1, stop - 60_000), "written");
    assert.equal(await writer.write(status("t-straggler", 1), 2, stop + 30_000), "written"); // alive after the stop
    assert.equal(await writer.write(status("t-copied", 0), 1, stop + 30_000), "written"); // another generation's item in g1
    for (let i = 0; i < 40; i += 1) await put(g1, { pk: S(`GAME#g${i}`), sk: S("HEAD"), owner_pool: S("p1"), pool_epoch: N(3) });
    const before = await snapshot(g1);
    assert.deepEqual(await oldGenerationHeartbeatsAfter(admin, g1, { generation: 1, after: stop }, { pageSize: 3 }), ["t-straggler"], "many pages, one fresh old-generation task");
    assert.deepEqual(await STAGING_HEARTBEATS(admin, g1, { generation: 1, after: stop + 60_000 }), [], "none fresh: proves nothing (the ECS listing is the stop proof)");
    assert.equal(await snapshot(g1), before, "the reader wrote nothing");
    /* A TASK# item the canonical decoder cannot read: the answer is unreadable, never "no heartbeat". */
    await put(g1, { pk: S("TASK#t-damaged"), sk: S("TASK"), fmt: N(1), task: S("t-damaged") });
    await assert.rejects(oldGenerationHeartbeatsAfter(admin, g1, { generation: 1, after: stop }), /TASK# item with the attributes/);
    await assert.rejects(oldGenerationHeartbeatsAfter(admin, `${g1}-missing`, { generation: 1, after: stop }), /ResourceNotFound|not found|non-existent/i);
  });

  test("through the certification's seam: the PREVIOUS generation's table and the stop's captured_at; a fresh heartbeat FAILS restore-quiet", async () => {
    const g1 = await tables.create("final-hb2-g1");
    const writer = dynamoTaskStatusWriter({ client: admin, table: g1 });
    const stopIso = "2026-09-30T09:30:00Z";
    assert.equal(await writer.write(status("t-late", 1), 1, Date.parse(stopIso) + 5_000), "written");
    const dir = fs.mkdtempSync(path.join(scratch, "hb-"));
    fs.mkdirSync(path.join(dir, RESTORE_STOP_DIR));
    fs.writeFileSync(path.join(dir, RESTORE_STOP_DIR, "stamp.json"), JSON.stringify({ format: "18COSMOS/L6-6-RESTORE-STOP/v2", run_id: "l6cert-final", restore_id: "r-final", captured_at: stopIso }));
    const adoption = { previous_generation: 1, adopted_at: Date.parse(stopIso) + 600_000, adopted_by: "op", restore_id: "r-final", game_table: "gs-staging-game-g2", claim: "c", generation: 2 };
    const evidence = await readRestoreHeartbeats(STAGING_HEARTBEATS, admin, { dir, adoption, tableOf: (g) => (g === 1 ? g1 : "gs-never-read") });
    assert.deepEqual(evidence, { integrated: true, oldGenerationAfterStop: ["t-late"] });
    const missing = await readRestoreHeartbeats(STAGING_HEARTBEATS, admin, { dir, adoption, tableOf: () => `${g1}-missing` });
    assert.ok(missing !== null && typeof missing.problem === "string" && /could not be read completely/.test(missing.problem), JSON.stringify(missing));
    /* The item in the table is still exactly the writer's (GetItem, strong): nothing read it into a decision. */
    const item = (await admin.send(new GetItemCommand({ TableName: g1, Key: { pk: S("TASK#t-late"), sk: S("TASK") }, ConsistentRead: true }), { abortSignal: deadline() })).Item;
    assert.equal(item?.seq?.N, "1");
  });
});

/* ==================================================================
    §4 LIVE-6 RELAYER ROTATION: THE POST-ROTATION PROOF OVER THE RUNTIME'S OWN ITEMS
   ================================================================== */
describe("§4 STAGING_ROTATION_READERS: the post-rotation proof reads what the runtime's own writers wrote", () => {
  test("a real takeover of the NEW relayer's role by the primary's current task, its own TASK# heartbeat: PASS; a newer task of the pool, a damaged heartbeat, old work: FAIL; zero writes", async () => {
    const game = await tables.create("final-rot-game");
    const ledger = await tables.create("final-rot-ledger");
    await put(ledger, { ...LEDGER_KEYS.appgen(), schema: N(1), current_generation: N(1) });
    const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../../../../infra/aws/fixtures/juno-backend-staging.json"), "utf8")) as Record<string, any>;
    const OLD = fixture.relayer.address as string;
    const NEW = addressOfPublicKey(publicKeyOf(Buffer.alloc(32, 0x21)), "juno");
    const oldDoc = JSON.parse(JSON.stringify(fixture));
    oldDoc.relayer.signer.key_ref = "arn:aws:kms:us-east-1:222222222222:key/00000000-0000-4000-8000-000000000000";
    const newDoc = JSON.parse(JSON.stringify(fixture));
    newDoc.relayer.address = NEW;
    newDoc.trust.operators = [NEW];
    const parse = (doc: unknown) => parseJunoBackendConfig(doc, { serverMode: "production", dataDir: "/nonexistent" });
    const gate = {
      format: "18COSMOS/RELAYER-ROTATION-GATE/v2", environment: "staging", from_relayer: OLD, to_relayer: NEW, configured_relayer: OLD, pools: ["p1"], evidence_captured_at: "2026-10-01T09:55:00Z", queue: "empty", verdict: "OPEN",
      checks: [{ name: "drained p1", status: "pass", detail: "" }], gated_at: "2026-10-01T10:00:00.000Z", deployment: deploymentIdentityOf(parse(oldDoc)), contract_operator: OLD,
    };
    /* The runtime's own writers: the routing, the primary pool's task, the relayer takeover (mint, then mirror), TASK#. */
    const clock = { now: Date.parse("2026-10-01T10:20:00Z") };
    assert.equal((await setPrimaryPool(admin, game, { pool: "p1", expectedVersion: null, by: "pipeline", now: 1 })).kind, "set");
    const writer = await PoolWriter.take({ client: admin, table: game, pool: "p1", task: "t-new-relayer-01", now: () => clock.now, onLost: () => undefined });
    const relayerLedger = await openDynamoSigningLedger(admin, { table: ledger, generation: 1, relayer: { address: NEW }, onFenced: ledgerFencedHook(writer), sleep: noSleep, resends: 2 });
    const taken = await takeRelayerRole(writer, { ledger: relayerLedger, now: () => clock.now, timing: { maxResends: 2, windowMs: 60_000, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep } });
    assert.equal(taken.kind, "taken");
    const heartbeat = dynamoTaskStatusWriter({ client: admin, table: game });
    const holder: TaskStatus = { task: "t-new-relayer-01", pool: "p1", poolEpoch: writer.epoch, generation: 1, environment: "staging", build: "b-rot", role: "primary", phase: "serving", ready: true, reasons: [], relayer: "usable", escrow: "active", poolWriterCheckAgeMs: 100, startedAt: clock.now - 300_000 };
    assert.equal(await heartbeat.write(holder, 7, clock.now - 15_000), "written");
    const proof = async () =>
      collectRotationProof({ readers: STAGING_ROTATION_READERS, juno: fakeJunoChain({ operator: NEW }), clients: { app: admin, ledger: admin }, tables: { game, ledger }, config: parse(newDoc), run: "l6cert-rot", environment: "staging", from: OLD, to: NEW, now: () => clock.now });
    const judged = async () => judgeRotationProof(await proof(), { ok: true, value: gate, sha256: "x" }, { environment: "staging", from: OLD, to: NEW, primaryPool: "p1", generation: 1 });
    const failed = (checks: Awaited<ReturnType<typeof judged>>) => checks.filter((c) => c.status !== "pass").map((c) => `${c.name}: ${c.detail}`).join("\n");
    const before = [await snapshot(game), await snapshot(ledger)];
    const good = await judged();
    assert.equal(failed(good), "", "the real items prove the rotation");
    assert.deepEqual([await snapshot(game), await snapshot(ledger)], before, "the proof's readers wrote nothing");
    /* A newer task of the primary pool: the mirror's holder is superseded (the role waits for the new task's takeover). */
    const newer = await PoolWriter.take({ client: admin, table: game, pool: "p1", task: "t-newer-02", now: () => clock.now, onLost: () => undefined });
    assert.match(failed(await judged()), new RegExp(`held by task t-new-relayer-01 at pool epoch ${writer.epoch}, but the primary's current task is t-newer-02 at epoch ${newer.epoch}`));
    newer.stop();
    writer.stop();
    /* A damaged heartbeat item is unreadable -- never "usable". */
    await put(game, { pk: S("TASK#t-new-relayer-01"), sk: S("TASK"), fmt: N(1), task: S("t-new-relayer-01") });
    assert.match(failed(await judged()), /the holder's TASK# heartbeat unreadable/);
    /* Work under the OLD address after the gate: never migrated, never ignored -- FAIL. */
    await put(game, { pk: S(`RELAYQ#${OLD}`), sk: S("1780000000000#g#x"), game_id: S("g"), intent_id: S("x"), created_at: N(1) });
    assert.match(failed(await judged()), /holds 1 entry: old-address work the new relayer never reads/);
  });
});
