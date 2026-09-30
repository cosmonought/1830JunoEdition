// server/src/persistence/conformance/stagingProbes.dynamoLocal.test.ts
//
// ==================================================================
//  LIVE-6 L6-6: THE STAGING PROBES AGAINST A REAL DYNAMODB ENGINE (DYNAMODB LOCAL) -- WHAT THEY WRITE, AND WHAT THEY DO NOT
// ==================================================================
//
// Runs ONLY against a DynamoDB Local named by GS_DYNAMODB_LOCAL_ENDPOINT (`npm run test:dynamodb-local`). DynamoDB Local
// has no IAM and is not the certification's target (the real service is): these cases prove the PROBES, not the service.
//   - the transaction probe drives the real engine through T1-T4 and its cleanup, touches only L6CERT#<run>, leaves the
//     table exactly as it found it, and refuses (untouched) a run id already used;
//   - the IAM probe against an engine WITHOUT IAM enforcement is judged UNEXPECTED WRITE AUTHORITY for every forbidden
//     shape -- a certification can never pass where IAM is not enforced -- and writes NOTHING (SYSTEM/ROUTING and APPGEN
//     byte-identical; the impossible condition held every write off).

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { PutItemCommand, ScanCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createDynamoDbClient, deadline, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../../aws/awsClients";
import { IAM_PROBE_IDS, judgeIamProbe, newProbeNonce, runIamProbe } from "../../aws/deploy/staging/iamProbe";
import { judgeTransactionProbe, runTransactionProbe } from "../../aws/deploy/staging/transactionProbe";
import { ConformanceTables, newRunId } from "./dynamoLocal";

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

after(async () => {
  await tables.dropAll();
  assert.deepEqual(tables.live, [], "every table this run made was dropped");
  admin.destroy();
});

const S = (v: string): AttributeValue => ({ S: v });
const put = (table: string, item: Record<string, AttributeValue>) => admin.send(new PutItemCommand({ TableName: table, Item: item }), { abortSignal: deadline() });
const scanAll = async (table: string): Promise<string> => {
  const items = (await admin.send(new ScanCommand({ TableName: table, ConsistentRead: true }), { abortSignal: deadline() })).Items ?? [];
  return JSON.stringify(items.map((i) => JSON.stringify(Object.keys(i).sort().map((k) => [k, i[k]]))).sort());
};

/** A game table as production holds it: the routing, a pool, a game's HEAD. */
async function seededGame(label: string): Promise<string> {
  const game = await tables.create(label);
  await put(game, { pk: S("SYSTEM"), sk: S("ROUTING"), fmt: { N: "1" }, primary_pool: S("p1"), routing_version: { N: "1" }, updated_at: { N: "1" }, updated_by: S("op"), claim: S("c") });
  await put(game, { pk: S("POOL#p1"), sk: S("POOL"), writer_epoch: { N: "3" }, writer_task: S("t-1"), taken_at: { N: "1" } });
  await put(game, { pk: S("GAME#g1"), sk: S("HEAD"), owner_pool: S("p1"), pool_epoch: { N: "3" } });
  return game;
}

describe("L6-6 on DynamoDB Local: the transaction probe", () => {
  test("T1-T4 against the real engine; only L6CERT#<run> is touched; the table ends exactly as it began", async () => {
    const game = await seededGame("l66-tx");
    const before = await scanAll(game);
    const run = `l6cert-local-${newRunId()}`;
    const record = await runTransactionProbe(admin, { run, gameTable: game, conflictRounds: 20, conflictWriters: 8 });
    const checks = judgeTransactionProbe({ status: "ran", results: record });
    const failed = checks.filter((c) => c.status !== "pass");
    /* DynamoDB Local may serialise concurrent transactions instead of cancelling them: then T3's conflict is NOT
       established -- and the harness says so (a FAIL), rather than passing on an engine that proves nothing. Every other
       assumption must hold on the real engine. */
    const conflicts = (record.t3 as { conflicts: number }).conflicts;
    assert.deepEqual(
      failed.map((c) => c.name),
      conflicts > 0 ? [] : ["T3 TransactionConflict is observed and classified not-applied"],
      JSON.stringify({ failed, record }, null, 2),
    );
    assert.equal((record.cleanup as { remaining: number }).remaining, 0);
    assert.equal(await scanAll(game), before, "SYSTEM/ROUTING, POOL#, GAME# byte-identical; no disposable item left");
    // eslint-disable-next-line no-console
    console.log(`    (DynamoDB Local: T3 observed ${conflicts} TransactionConflict(s) in 20x8 concurrent writes; ${(record.t3 as { applied: number }).applied} applied)`);
  });

  test("a run id that already holds items is refused, and those items are left untouched", async () => {
    const game = await seededGame("l66-reuse");
    const run = `l6cert-local-${newRunId()}`;
    await put(game, { pk: S(`L6CERT#${run}`), sk: S("T1-A"), v: { N: "7" } });
    const before = await scanAll(game);
    const record = await runTransactionProbe(admin, { run, gameTable: game, conflictRounds: 1, conflictWriters: 2 });
    assert.match(String(record.refused), /already holds 1 item/);
    assert.equal(await scanAll(game), before);
    assert.ok(judgeTransactionProbe({ status: "ran", results: record }).some((c) => c.status === "fail"));
  });
});

describe("L6-6 on DynamoDB Local: the IAM probe where IAM is NOT enforced", () => {
  test("every forbidden shape is UNEXPECTED WRITE AUTHORITY; nothing at all is written", async () => {
    const game = await seededGame("l66-iam-game");
    const ledger = await tables.create("l66-iam-ledger");
    await put(ledger, { pk: S("APPGEN"), sk: S("APPGEN"), schema: { N: "1" }, current_generation: { N: "1" } });
    const beforeGame = await scanAll(game);
    const beforeLedger = await scanAll(ledger);
    const run = `l6cert-local-${newRunId()}`;
    const { results } = await runIamProbe({ game: admin, ledger: admin }, { run, gameTable: game, ledgerTable: ledger, nonce: newProbeNonce() });
    const checks = judgeIamProbe({ status: "ran", results }, "gs-staging-app-task", IAM_PROBE_IDS);
    const byOutcome = new Map<string, string[]>();
    for (const c of checks.filter((x) => x.name.startsWith("IAM ") && x.name !== "IAM: every probe ran")) {
      const outcome = c.detail.split(":")[0];
      byOutcome.set(outcome, [...(byOutcome.get(outcome) ?? []), c.name]);
    }
    assert.deepEqual([...byOutcome.keys()].sort(), ["authorized-as-expected", "unexpected-write-authority"], JSON.stringify([...byOutcome]));
    assert.equal(byOutcome.get("unexpected-write-authority")?.length, 9, "all nine forbidden shapes reached condition evaluation");
    assert.equal(byOutcome.get("authorized-as-expected")?.length, 4);
    assert.ok(checks.some((c) => c.status === "fail"), "a certification can never pass where IAM is not enforced");
    assert.equal(await scanAll(game), beforeGame, "SYSTEM/ROUTING untouched; nothing written");
    assert.equal(await scanAll(ledger), beforeLedger, "APPGEN untouched; nothing written");
  });
});
