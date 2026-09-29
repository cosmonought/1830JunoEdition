// server/src/persistence/conformance/dynamoLocal.conformance.test.ts
//
// LIVE-5 L5-1: the DynamoDB-Local proof. Runs ONLY against a DynamoDB Local named by GS_DYNAMODB_LOCAL_ENDPOINT
// (`npm run test:dynamodb-local`; see server/src/aws/README.md for starting one). It is not part of `npm test`: it needs
// a local service, and without one it FAILS with instructions rather than skipping quietly.
//
// What it proves:
//   1. the substrate: only loopback clients, one table per case under a per-run prefix, deterministic cleanup that
//      touches nothing else, client-level faults that fire exactly as scripted;
//   2. the DynamoDB semantics later slices rely on: a resend with the same ClientRequestToken is idempotent; the same
//      token with a different request is refused; a TransactionCanceled names the failed term;
//   3. the harness: FINANCIAL_CASES -- the same cases the memory and file stores run -- pass against the proof adapter,
//      including the ones a file store cannot (the fence inside the write, the idempotent resend, paged listings).

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { GetItemCommand, ListTablesCommand, PutItemCommand, TransactWriteItemsCommand, UpdateItemCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createDynamoDbClient, deadline, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../../aws/awsClients";
import { FINANCIAL_CASES, type FinancialSubject } from "./escrowStores.conformance";
import { FaultScript, gate } from "./faults";
import { createDynamoProofFinancialStore, FENCE_KEY } from "./dynamoProofFinancialStore";
import { ConformanceTables, installFaults, newRunId, requireLocal, TABLE_PREFIX } from "./dynamoLocal";
import { runConformance, type CaseContext } from "./harness";
import { financialBytes } from "./subjects";

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
const RUN = newRunId();
const admin: DynamoDBClient = createDynamoDbClient(TARGET);
const tables = new ConformanceTables(admin, RUN);
const S = (value: string) => ({ S: value });

after(async () => {
  await tables.dropAll();
  /* Every page of the listing (a crashed earlier run's tables may be many): none of THIS run's may remain. */
  const left: string[] = [];
  let start: string | undefined;
  do {
    const page = await admin.send(new ListTablesCommand({ ExclusiveStartTableName: start }), { abortSignal: deadline() });
    left.push(...(page.TableNames ?? []));
    start = page.LastEvaluatedTableName;
  } while (start !== undefined);
  assert.deepEqual(left.filter((name) => name.startsWith(tables.prefix)), [], "every table this run created was deleted");
  admin.destroy();
});

/* ------------------------------------------------------------------ */
/* 1-2. The substrate and the DynamoDB semantics it relies on          */
/* ------------------------------------------------------------------ */

describe("L5-1 DynamoDB Local substrate", () => {
  let table = "";
  before(async () => {
    await requireLocal(admin);
    table = await tables.create("substrate");
  });

  test("only a loopback DynamoDB Local client is accepted", async () => {
    await requireLocal(admin);
    const real = createDynamoDbClient({ kind: "aws", region: "us-east-1" });
    await assert.rejects(requireLocal(real), /no explicit endpoint/);
    real.destroy();
  });

  test("tables are named under this run's prefix; a table this run did not create is never deleted", async () => {
    assert.ok(table.startsWith(`${TABLE_PREFIX}${RUN}-`));
    const other = new ConformanceTables(admin, newRunId());
    await assert.rejects(other.drop(table), /did not create it/);
    await assert.rejects(tables.drop(`${TABLE_PREFIX}${RUN}-999-not-ours`), /did not create it/);
  });

  test("a resend with the same ClientRequestToken is idempotent: applied once, answered success", async () => {
    const token = randomUUID();
    const request = () =>
      new TransactWriteItemsCommand({
        ClientRequestToken: token,
        TransactItems: [{ Update: { TableName: table, Key: { pk: S("IDEM"), sk: S("X") }, UpdateExpression: "ADD #n :one", ExpressionAttributeNames: { "#n": "n" }, ExpressionAttributeValues: { ":one": { N: "1" } } } }],
      });
    await admin.send(request(), { abortSignal: deadline() });
    await admin.send(request(), { abortSignal: deadline() });
    const item = await admin.send(new GetItemCommand({ TableName: table, Key: { pk: S("IDEM"), sk: S("X") }, ConsistentRead: true }), { abortSignal: deadline() });
    assert.equal(item.Item?.n?.N, "1", "the resend did not apply the update a second time");
  });

  test("the same token with a different request is refused (IdempotentParameterMismatch), and nothing is applied", async () => {
    const token = randomUUID();
    const put = (value: string) => new TransactWriteItemsCommand({ ClientRequestToken: token, TransactItems: [{ Put: { TableName: table, Item: { pk: S("MISMATCH"), sk: S("X"), v: S(value) } } }] });
    await admin.send(put("first"), { abortSignal: deadline() });
    await assert.rejects(admin.send(put("second"), { abortSignal: deadline() }), (error: Error) => error.name === "IdempotentParameterMismatchException");
    const item = await admin.send(new GetItemCommand({ TableName: table, Key: { pk: S("MISMATCH"), sk: S("X") }, ConsistentRead: true }), { abortSignal: deadline() });
    assert.equal(item.Item?.v?.S, "first");
  });

  test("a cancelled transaction names the term that failed", async () => {
    await admin.send(new PutItemCommand({ TableName: table, Item: { pk: S("CANCEL"), sk: S("A"), v: { N: "1" } } }), { abortSignal: deadline() });
    await assert.rejects(
      admin.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            { ConditionCheck: { TableName: table, Key: { pk: S("CANCEL"), sk: S("A") }, ConditionExpression: "v = :one", ExpressionAttributeValues: { ":one": { N: "1" } } } },
            { Put: { TableName: table, Item: { pk: S("CANCEL"), sk: S("B") }, ConditionExpression: "attribute_exists(pk)" } },
          ],
        }),
        { abortSignal: deadline() },
      ),
      (error: Error & { CancellationReasons?: Array<{ Code?: string }> }) => error.name === "TransactionCanceledException" && error.CancellationReasons?.[0]?.Code === "None" && error.CancellationReasons?.[1]?.Code === "ConditionalCheckFailed",
    );
  });

  test("client-level faults fire exactly as scripted: fail sends nothing, lose-answer applies then fails, stall waits for its gate", async () => {
    const client = createDynamoDbClient(TARGET);
    const script = new FaultScript();
    const uninstall = installFaults(client, script);
    const key = (sk: string) => ({ pk: S("FAULT"), sk: S(sk) });
    const put = (sk: string) => new PutItemCommand({ TableName: table, Item: { ...key(sk), v: S(sk) } });
    const exists = async (sk: string) => (await admin.send(new GetItemCommand({ TableName: table, Key: key(sk), ConsistentRead: true }), { abortSignal: deadline() })).Item !== undefined;
    script.add({ op: "PutItemCommand", nth: 1, action: { kind: "fail" } });
    script.add({ op: "PutItemCommand", nth: 2, action: { kind: "lose-answer" } });
    const stall = gate();
    script.add({ op: "PutItemCommand", nth: 3, action: { kind: "stall", gate: stall } });
    await assert.rejects(client.send(put("a")), (error: Error) => error.name === "ThrottlingException");
    assert.equal(await exists("a"), false, "a failed request was never sent");
    await assert.rejects(client.send(put("b")), (error: Error) => error.name === "TimeoutError");
    assert.equal(await exists("b"), true, "a lost answer's request was applied");
    const pending = client.send(put("c"));
    await stall.reached;
    assert.equal(await exists("c"), false, "a stalled request has not been sent");
    stall.release();
    await pending;
    assert.equal(await exists("c"), true);
    assert.deepEqual(script.unfired(), []);
    uninstall();
    client.destroy();
  });
});

/* ------------------------------------------------------------------ */
/* 3. The financial-record conformance cases, against the proof adapter */
/* ------------------------------------------------------------------ */

interface CaseTable {
  readonly table: string;
  readonly client: DynamoDBClient;
}
const perCase = new WeakMap<CaseContext, CaseTable>();

async function caseTable(ctx: CaseContext): Promise<CaseTable> {
  const known = perCase.get(ctx);
  if (known !== undefined) return known;
  const table = await tables.create("financial");
  const client = createDynamoDbClient(TARGET);
  await requireLocal(client);
  installFaults(client, ctx.faults);
  /* The fence item, and a takeover that moves it (the harness's fence is the writer epoch). */
  await admin.send(new PutItemCommand({ TableName: table, Item: { ...FENCE_KEY, epoch: { N: String(ctx.fence.epoch) } } }), { abortSignal: deadline() });
  ctx.fence.onTakeOver(async (epoch) => {
    await admin.send(new UpdateItemCommand({ TableName: table, Key: FENCE_KEY, UpdateExpression: "SET #e = :e", ExpressionAttributeNames: { "#e": "epoch" }, ExpressionAttributeValues: { ":e": { N: String(epoch) } } }), { abortSignal: deadline() });
  });
  ctx.defer(async () => {
    client.destroy();
    await tables.drop(table);
  });
  const entry = { table, client };
  perCase.set(ctx, entry);
  return entry;
}

const writesTo = (gameId: string) => (detail: string) => detail.includes(`GAME#${gameId}`);

const dynamoProof: FinancialSubject = {
  name: "dynamodb-local (proof adapter)",
  backend: "dynamodb",
  capabilities: ["durable", "fence", "fence-in-write", "cas-in-write", "plant", "stall-write", "inject-lost-answer", "inject-transient-failure", "validates-shape", "idempotency-token"],
  exemptions: {
    "inject-unevaluated": "the L5-1 proof adapter resends once and answers `uncertain` without a settling read after an unevaluated resend; L5-2's dynamoFinancialStore (the production adapter) declares it and passes the cases",
  },
  async open(ctx) {
    const { client, table } = await caseTable(ctx);
    return createDynamoProofFinancialStore(client, table, { epoch: ctx.fence.epoch, pageSize: 5 });
  },
  async plant(ctx, gameId, what) {
    const { table } = await caseTable(ctx);
    const body = financialBytes(gameId, what);
    await admin.send(new PutItemCommand({ TableName: table, Item: { pk: S(`GAME#${gameId}`), sk: S("FIN"), body: S(body) } }), { abortSignal: deadline() });
  },
  async stored(ctx, gameId) {
    const { table } = await caseTable(ctx);
    const answer = await admin.send(new GetItemCommand({ TableName: table, Key: { pk: S(`GAME#${gameId}`), sk: S("FIN") }, ConsistentRead: true }), { abortSignal: deadline() });
    return answer.Item?.body?.S ?? null;
  },
  writeTokens(ctx, gameId) {
    return ctx.faults.calls
      .filter((call) => call.op === "TransactWriteItemsCommand" && writesTo(gameId)(call.detail))
      .map((call) => (JSON.parse(call.detail) as { ClientRequestToken?: string }).ClientRequestToken ?? "");
  },
  armLostAnswer(ctx, gameId) {
    ctx.faults.add({ op: "TransactWriteItemsCommand", where: writesTo(gameId), action: { kind: "lose-answer" }, label: "the write lands, its answer is lost" });
  },
  armTransientFailure(ctx, gameId) {
    ctx.faults.add({ op: "TransactWriteItemsCommand", where: writesTo(gameId), action: { kind: "fail" }, label: "the write is throttled" });
  },
  armUnknownThenStallResend(ctx, gameId, landed) {
    const resend = gate();
    ctx.faults.add({ op: "TransactWriteItemsCommand", where: writesTo(gameId), nth: 1, action: landed ? { kind: "lose-answer" } : { kind: "fail", code: "TimeoutError" }, label: landed ? "the write lands, its answer is lost" : "the write times out before it is sent" });
    ctx.faults.add({ op: "TransactWriteItemsCommand", where: writesTo(gameId), nth: 2, action: { kind: "stall", gate: resend }, label: "the resend stalls" });
    return resend;
  },
  stallNextWrite(ctx, gameId) {
    const stall = gate();
    ctx.faults.add({ op: "TransactWriteItemsCommand", where: writesTo(gameId), action: { kind: "stall", gate: stall }, label: "the write stalls before it is sent" });
    return stall;
  },
};

runConformance("financial record", [dynamoProof], FINANCIAL_CASES);
