// server/src/persistence/conformance/hostCertLock.dynamoLocal.test.ts
//
// COST-2C on DynamoDB Local: the host drills' DynamoDB writes and reads against the real engine -- the staging drill lock
// (`OPRUN#host-cert` / `LOCK`: conditional PutItems only), the parse-free open-money count (FINKEYS / FINIDX#), and the
// identity-writer role reader the drills bind (`tools/awsDeploy.ts` HOST_CERT_READERS). Part of `test:dynamodb-local`.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { PutItemCommand, ScanCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createDynamoDbClient, deadline, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../../aws/awsClients";
import { acquireLock, CLOCK_SKEW_MS, readLock, releaseLock, renewLock } from "../../aws/deploy/hostcert/drillLock";
import { openMoneyState } from "../../aws/deploy/hostcert/controlPlane";
import { HOST_CERT_READERS } from "../../tools/awsDeploy";
import { ConformanceTables, newRunId } from "./dynamoLocal";

const target = dynamoLocalTargetFromEnv();
if (target === null) {
  throw new Error(
    `${DYNAMODB_LOCAL_ENV} is not set. Start DynamoDB Local on this machine and point the suite at it, e.g.\n` +
      `  docker run --rm -p 127.0.0.1:8000:8000 amazon/dynamodb-local:3.3.1 -jar DynamoDBLocal.jar -inMemory\n` +
      `  ${DYNAMODB_LOCAL_ENV}=http://127.0.0.1:8000 npm run test:dynamodb-local\n`,
  );
}
const admin: DynamoDBClient = createDynamoDbClient(target);
const tables = new ConformanceTables(admin, newRunId());

after(async () => {
  await tables.dropAll();
  assert.deepEqual(tables.live, [], "every table this run made was dropped");
  admin.destroy();
});

const S = (v: string): AttributeValue => ({ S: v });
const T0 = Date.parse("2026-10-02T20:00:00Z");
const base = { scenario: "crash-restart", instance: "i-0123456789abcdef0", operator: "owner", sourceCommit: "1".repeat(40), leaseMs: 3_600_000, reclaim: null };

describe("COST-2C on DynamoDB Local: the staging drill lock", () => {
  test("acquire / refuse / renew / release; only the lock item is written", async () => {
    const game = await tables.create("hc-lock");
    const a = await acquireLock(admin, game, { ...base, run: "run-aaaaaa", now: T0 });
    assert.equal(a.kind, "held");
    assert.equal((await acquireLock(admin, game, { ...base, run: "run-bbbbbb", now: T0 + 1 })).kind, "refused");
    if (a.kind !== "held") return;
    assert.equal((await renewLock(admin, game, a.holder, T0 + 2, 3_600_000)).kind, "held");
    assert.equal((await releaseLock(admin, game, a.holder, T0 + 3, "done")).kind, "held");
    const read = await readLock(admin, game);
    assert.ok(read.state === "ok" && read.holder.outcome === "released");
    const items = (await admin.send(new ScanCommand({ TableName: game, ConsistentRead: true }), { abortSignal: deadline() })).Items ?? [];
    assert.deepEqual(items.map((i) => `${i.pk?.S}|${i.sk?.S}`), ["OPRUN#host-cert|LOCK"]);
  });
  test("racing acquires on the real engine: exactly one wins", async () => {
    const game = await tables.create("hc-race");
    const all = await Promise.all(Array.from({ length: 8 }, (_, i) => acquireLock(admin, game, { ...base, run: `run-race${i}a`, now: T0 })));
    assert.equal(all.filter((r) => r.kind === "held").length, 1, JSON.stringify(all.map((r) => r.kind)));
  });
  test("stale recovery: only the named, expired holder; the reclaimed run's renew and release then fail", async () => {
    const game = await tables.create("hc-stale");
    const a = await acquireLock(admin, game, { ...base, run: "run-aaaaaa", now: T0, leaseMs: 60_000 });
    assert.equal(a.kind, "held");
    const late = T0 + 60_000 + CLOCK_SKEW_MS + 1;
    assert.equal((await acquireLock(admin, game, { ...base, run: "run-bbbbbb", now: late })).kind, "refused");
    assert.equal((await acquireLock(admin, game, { ...base, run: "run-bbbbbb", now: T0 + 60_000, reclaim: "run-aaaaaa" })).kind, "refused");
    assert.equal((await acquireLock(admin, game, { ...base, run: "run-bbbbbb", now: late, reclaim: "run-aaaaaa" })).kind, "held");
    if (a.kind === "held") {
      assert.equal((await renewLock(admin, game, a.holder, late + 1, 60_000)).kind, "refused");
      assert.equal((await releaseLock(admin, game, a.holder, late + 1, "x")).kind, "refused");
    }
  });
});

describe("COST-2C on DynamoDB Local: the readings the drills bind", () => {
  test("open money: none, then open (any FINIDX# item counts), never parsed", async () => {
    const game = await tables.create("hc-money");
    assert.deepEqual(await openMoneyState(admin, game), { state: "none" });
    await admin.send(new PutItemCommand({ TableName: game, Item: { pk: S("FINKEYS"), sk: S("FINKEYS"), keys: { SS: ["k1"] } } }), { abortSignal: deadline() });
    assert.deepEqual(await openMoneyState(admin, game), { state: "none" });
    await admin.send(new PutItemCommand({ TableName: game, Item: { pk: S("FINIDX#k1"), sk: S("GAME#g-1"), game_id: S("g-1") } }), { abortSignal: deadline() });
    assert.deepEqual(await openMoneyState(admin, game), { state: "open", count: 1 });
  });
  test("the identity-writer role reader the drills bind: an absent role is null (never a holder)", async () => {
    const identity = await tables.create("hc-identity");
    assert.equal(await HOST_CERT_READERS.identityRole(admin, identity), null);
  });
});
