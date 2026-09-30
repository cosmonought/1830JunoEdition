// server/src/persistence/conformance/identityDynamoSubjects.ts
//
// LIVE-5 L5-4: the DynamoDB-Local subjects of the identity ports (identity, sensitive-auth grants, the security-event
// journal), and the suite plumbing their test files share. Registers no test itself. Every client comes from
// `createDynamoDbClient` and is refused unless it is a loopback DynamoDB Local client (`requireLocal`); every table is
// created per case under this run's prefix and dropped by the case (`ConformanceTables`).

import { after } from "node:test";
import assert from "node:assert/strict";
import { GetItemCommand, ListTablesCommand, PutItemCommand, ScanCommand, UpdateItemCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createDynamoDbClient, deadline, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../../aws/awsClients";
import { createDynamoIdentityStore, type DynamoIdentityStore, type DynamoIdentityStoreOptions } from "../../aws/identity/dynamoIdentityStore";
import { APPGEN_KEY, createDynamoSecurityJournal, securityEventKey } from "../../aws/identity/dynamoSecurityJournal";
import { keyAttributes, keys, ROLE_KEY, type Item } from "../../aws/identity/identityItems";
import { gate, type Gate } from "./faults";
import { ConformanceTables, installFaults, newRunId, requireLocal } from "./dynamoLocal";
import type { CaseContext } from "./harness";
import type { IdentitySubject } from "./identityJournal.conformance";
import type { GrantSubject, SecuritySubject } from "./identitySecurity.conformance";

export const IMMEDIATE = async (): Promise<void> => undefined;
export const QUIET = (): void => undefined;
/** The adapter's resends of an unknown outcome in these suites (its default). */
export const RESENDS = 3;
/** A grant write's resends (review F4: one). */
export const GRANT_RESENDS = 1;
/** The security-event journal's resends (its default). */
export const JOURNAL_RESENDS = 3;

/** L5-2's `inject-unevaluated`, joined by the L5-4 subjects at integration: the next write's attempt -- `landed` (its
 *  answer lost) or not (unsent) -- and each of the store's `resends` time out unsent; reads still work, so the store
 *  settles what it can see: visible -> written, invisible -> UNKNOWN. */
function unevaluatedHook(resends: number) {
  return (ctx: CaseContext, landed: boolean): void => {
    ctx.faults.add({
      op: "TransactWriteItemsCommand",
      nth: 1,
      action: landed ? { kind: "lose-answer" } : { kind: "fail", code: "TimeoutError" },
      label: landed ? "the write lands, its answer is lost" : "the write times out before it is sent",
    });
    for (let n = 2; n <= resends + 1; n += 1) ctx.faults.add({ op: "TransactWriteItemsCommand", nth: n, action: { kind: "fail", code: "TimeoutError" }, label: `resend ${n - 1} times out unsent` });
  };
}

export interface DynamoSuite {
  readonly target: { readonly kind: "dynamodb-local"; readonly endpoint: string };
  readonly admin: DynamoDBClient;
  readonly tables: ConformanceTables;
  /** A fresh client for the suite's own use (faults can be installed on it). Destroyed with the suite. */
  client(): Promise<DynamoDBClient>;
}

/** The suite's DynamoDB Local, or a failure with instructions (never a quiet skip). Registers the cleanup. */
export function dynamoSuite(): DynamoSuite {
  const target = dynamoLocalTargetFromEnv();
  if (target === null) {
    throw new Error(
      `${DYNAMODB_LOCAL_ENV} is not set. Start DynamoDB Local on this machine and point the suite at it, e.g.\n` +
        "  docker run --rm -p 127.0.0.1:8000:8000 amazon/dynamodb-local:3.3.1 -jar DynamoDBLocal.jar -inMemory\n" +
        `  ${DYNAMODB_LOCAL_ENV}=http://127.0.0.1:8000 npm run test:dynamodb-local\n` +
        "(server/src/aws/README.md has the Java route and the Windows PowerShell spelling).",
    );
  }
  const admin = createDynamoDbClient(target);
  const tables = new ConformanceTables(admin, newRunId());
  const clients: DynamoDBClient[] = [];
  after(async () => {
    for (const client of clients) client.destroy();
    await tables.dropAll();
    const left: string[] = [];
    let start: string | undefined;
    do {
      const page = await admin.send(new ListTablesCommand({ ExclusiveStartTableName: start }), { abortSignal: deadline() });
      left.push(...(page.TableNames ?? []));
      start = page.LastEvaluatedTableName;
    } while (start !== undefined);
    assert.deepEqual(
      left.filter((name) => name.startsWith(tables.prefix)),
      [],
      "every table this run created was deleted",
    );
    admin.destroy();
  });
  return {
    target,
    admin,
    tables,
    async client() {
      const client = createDynamoDbClient(target);
      await requireLocal(client);
      clients.push(client);
      return client;
    },
  };
}

/** Every item of a table, strongly read, in key order, minus the items named by `except` (pk values). */
export async function tableItems(admin: DynamoDBClient, table: string, except: readonly string[] = []): Promise<Item[]> {
  const items: Item[] = [];
  let start: Record<string, AttributeValue> | undefined;
  do {
    const page = await admin.send(new ScanCommand({ TableName: table, ConsistentRead: true, ExclusiveStartKey: start }), { abortSignal: deadline() });
    items.push(...((page.Items ?? []) as Item[]));
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  const key = (item: Item) => `${item.pk?.S ?? ""}|${item.sk?.S ?? ""}`;
  return items.filter((item) => !except.includes(item.pk?.S ?? "")).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** A canonical text of items (attribute names sorted), for "nothing was written" comparisons. */
export function itemsText(items: readonly Item[]): string {
  return items.map((item) => JSON.stringify(Object.keys(item).sort().map((name) => [name, item[name]]))).join("\n");
}

/** The role item as the harness's fence puts it (a takeover moves `epoch`). */
export const roleItem = (epoch: number): Item => ({
  ...keyAttributes(ROLE_KEY),
  epoch: { N: String(epoch) },
  task: { S: "conformance" },
  pool: { S: "conformance" },
  taken_at: { N: "1780000000000" },
  claim: { S: "00000000-0000-4000-8000-000000000000" },
});

const writesOf = (ctx: CaseContext) => ctx.faults.calls.filter((call) => call.op === "TransactWriteItemsCommand");
const onWrites = { op: "TransactWriteItemsCommand" };

/** The fault hooks every DynamoDB subject shares: they aim at the case client's transactions. */
function transactionHooks() {
  return {
    stallNextWrite(ctx: CaseContext): Gate {
      const stall = gate();
      ctx.faults.add({ ...onWrites, action: { kind: "stall", gate: stall }, label: "the transaction stalls before it is sent" });
      return stall;
    },
    armLostAnswer(ctx: CaseContext): void {
      ctx.faults.add({ ...onWrites, action: { kind: "lose-answer" }, label: "the transaction lands, its answer is lost" });
    },
    armTransientFailure(ctx: CaseContext): void {
      ctx.faults.add({ ...onWrites, action: { kind: "fail" }, label: "the transaction is throttled" });
    },
    armUnknownThenStallResend(ctx: CaseContext, landed: boolean): Gate {
      const resend = gate();
      ctx.faults.add({ ...onWrites, nth: 1, action: landed ? { kind: "lose-answer" } : { kind: "fail", code: "TimeoutError" }, label: landed ? "the transaction lands, its answer is lost" : "the transaction times out before it is sent" });
      ctx.faults.add({ ...onWrites, nth: 2, action: { kind: "stall", gate: resend }, label: "the resend stalls" });
      return resend;
    },
    writeTokens(ctx: CaseContext): string[] {
      return writesOf(ctx).map((call) => (JSON.parse(call.detail) as { ClientRequestToken?: string }).ClientRequestToken ?? "");
    },
    armUnresolvedWrite(ctx: CaseContext): void {
      for (let n = 1; n <= RESENDS + 1; n += 1) ctx.faults.add({ ...onWrites, nth: n, action: { kind: "fail", code: "TimeoutError" }, label: `send ${n} of the transaction times out` });
    },
  };
}

/* ------------------------------------------------------------------ */
/* The identity table of one case                                      */
/* ------------------------------------------------------------------ */

interface IdentityCase {
  readonly table: string;
  readonly client: DynamoDBClient;
  readonly held: string[];
  readonly fenced: string[];
}

export function identitySubjects(suite: DynamoSuite, overrides: Partial<DynamoIdentityStoreOptions> = {}): { identity: IdentitySubject; grants: GrantSubject; tableOf(ctx: CaseContext): Promise<IdentityCase> } {
  const perCase = new WeakMap<CaseContext, Promise<IdentityCase>>();
  const tableOf = (ctx: CaseContext): Promise<IdentityCase> => {
    let known = perCase.get(ctx);
    if (known === undefined) {
      known = (async () => {
        const table = await suite.tables.create("identity");
        const client = createDynamoDbClient(suite.target);
        await requireLocal(client);
        installFaults(client, ctx.faults);
        await suite.admin.send(new PutItemCommand({ TableName: table, Item: roleItem(ctx.fence.epoch) }), { abortSignal: deadline() });
        ctx.fence.onTakeOver(async (epoch) => {
          await suite.admin.send(
            new UpdateItemCommand({ TableName: table, Key: keyAttributes(ROLE_KEY), UpdateExpression: "SET #e = :e", ExpressionAttributeNames: { "#e": "epoch" }, ExpressionAttributeValues: { ":e": { N: String(epoch) } } }),
            { abortSignal: deadline() },
          );
        });
        ctx.defer(async () => {
          client.destroy();
          await suite.tables.drop(table);
        });
        return { table, client, held: [], fenced: [] };
      })();
      perCase.set(ctx, known);
    }
    return known;
  };
  const open = async (ctx: CaseContext): Promise<DynamoIdentityStore> => {
    const entry = await tableOf(ctx);
    return createDynamoIdentityStore(entry.client, entry.table, {
      epoch: ctx.fence.epoch,
      sleep: IMMEDIATE,
      scanSegments: 2,
      pageSize: 40,
      warn: QUIET,
      onRestartRequired: (detail) => entry.held.push(detail),
      onFenced: (detail) => entry.fenced.push(detail),
      ...overrides,
    });
  };
  const hooks = transactionHooks();
  const capabilities = ["durable", "fence", "fence-in-write", "plant", "stall-write", "idempotency-token", "inject-lost-answer", "inject-transient-failure", "inject-unevaluated", "validates-shape"] as const;

  const identity: IdentitySubject = {
    name: "dynamodb-local (createDynamoIdentityStore)",
    backend: "dynamodb",
    /* `cas-in-write` (L5-2): every precondition of a change is a condition of its own write (the L5-4 properties judge 700
       random changes by the table's conditions alone). */
    capabilities: [...capabilities, "cas-in-write", "inject-unresolved"],
    open,
    async stored(ctx) {
      const { table } = await tableOf(ctx);
      return itemsText(await tableItems(suite.admin, table, [ROLE_KEY.pk]));
    },
    /* Damage: the first session item's `expires_at` becomes a string (a type no session field has). */
    async plant(ctx) {
      const { table } = await tableOf(ctx);
      const session = (await tableItems(suite.admin, table)).find((item) => item.pk?.S?.startsWith("SESS#"));
      if (session === undefined) throw new Error("plant: no session item");
      await suite.admin.send(new PutItemCommand({ TableName: table, Item: { ...session, expires_at: { S: "soon" } } }), { abortSignal: deadline() });
    },
    ...hooks,
    armUnevaluated: unevaluatedHook(RESENDS),
  };

  const grants: GrantSubject = {
    name: "dynamodb-local (createDynamoIdentityStore().grants)",
    backend: "dynamodb",
    capabilities: [...capabilities],
    exemptions: {
      "cas-in-write": "a grant write has no condition of its own: it replaces the session's grant whole (the newer grant is the one that counts, OD-5-4), under the role fence inside the write (GRANT-07, GRANT-08)",
    },
    async open(ctx) {
      return (await open(ctx)).grants;
    },
    async stored(ctx) {
      const { table } = await tableOf(ctx);
      return itemsText((await tableItems(suite.admin, table, [ROLE_KEY.pk])).filter((item) => item.pk?.S?.startsWith("GRANT#")));
    },
    /* Damage: the grant's TTL no longer follows its expiry. */
    async plant(ctx, sessionId) {
      const { table } = await tableOf(ctx);
      const stored = await suite.admin.send(new GetItemCommand({ TableName: table, Key: keyAttributes(keys.grant(sessionId)), ConsistentRead: true }), { abortSignal: deadline() });
      if (stored.Item === undefined) throw new Error("plant: no such grant");
      await suite.admin.send(new PutItemCommand({ TableName: table, Item: { ...(stored.Item as Item), ttl: { N: "1" } } }), { abortSignal: deadline() });
    },
    stallNextWrite: hooks.stallNextWrite,
    armLostAnswer: hooks.armLostAnswer,
    armTransientFailure: hooks.armTransientFailure,
    writeTokens: hooks.writeTokens,
    armUnevaluated: unevaluatedHook(GRANT_RESENDS),
  };
  return { identity, grants, tableOf };
}

/* ------------------------------------------------------------------ */
/* The ledger table of one case: the security-event journal             */
/* ------------------------------------------------------------------ */

export function securitySubject(suite: DynamoSuite): SecuritySubject {
  const perCase = new WeakMap<CaseContext, Promise<{ table: string; client: DynamoDBClient }>>();
  const tableOf = (ctx: CaseContext) => {
    let known = perCase.get(ctx);
    if (known === undefined) {
      known = (async () => {
        const table = await suite.tables.create("ledger-sec");
        const client = createDynamoDbClient(suite.target);
        await requireLocal(client);
        installFaults(client, ctx.faults);
        await suite.admin.send(new PutItemCommand({ TableName: table, Item: { ...APPGEN_KEY, current_generation: { N: String(ctx.fence.epoch) } } }), { abortSignal: deadline() });
        ctx.fence.onTakeOver(async (epoch) => {
          await suite.admin.send(
            new UpdateItemCommand({ TableName: table, Key: { ...APPGEN_KEY }, UpdateExpression: "SET #g = :g", ExpressionAttributeNames: { "#g": "current_generation" }, ExpressionAttributeValues: { ":g": { N: String(epoch) } } }),
            { abortSignal: deadline() },
          );
        });
        ctx.defer(async () => {
          client.destroy();
          await suite.tables.drop(table);
        });
        return { table, client };
      })();
      perCase.set(ctx, known);
    }
    return known;
  };
  const hooks = transactionHooks();
  return {
    name: "dynamodb-local (createDynamoSecurityJournal)",
    backend: "dynamodb",
    /* `cas-in-write` (L5-2): an event is created if absent inside its own write (first writer wins, SEC-02). */
    capabilities: ["durable", "fence", "fence-in-write", "cas-in-write", "plant", "stall-write", "idempotency-token", "inject-lost-answer", "inject-transient-failure", "inject-unevaluated", "validates-shape"],
    async open(ctx) {
      const { table, client } = await tableOf(ctx);
      return createDynamoSecurityJournal(client, table, { generation: ctx.fence.epoch, sleep: IMMEDIATE, pageSize: 2 });
    },
    async stored(ctx) {
      const { table } = await tableOf(ctx);
      return itemsText(await tableItems(suite.admin, table, ["APPGEN"]));
    },
    /* Damage: the event's body names another version (it no longer parses as a v1 event). */
    async plant(ctx, event) {
      const { table } = await tableOf(ctx);
      const stored = await suite.admin.send(new GetItemCommand({ TableName: table, Key: securityEventKey(event), ConsistentRead: true }), { abortSignal: deadline() });
      if (stored.Item === undefined) throw new Error("plant: no such event");
      const body = (stored.Item.body?.S ?? "").replace('"version":1', '"version":2');
      await suite.admin.send(new PutItemCommand({ TableName: table, Item: { ...(stored.Item as Item), body: { S: body } } }), { abortSignal: deadline() });
    },
    stallNextWrite: hooks.stallNextWrite,
    armLostAnswer: hooks.armLostAnswer,
    armTransientFailure: hooks.armTransientFailure,
    writeTokens: hooks.writeTokens,
    armUnknownThenStallResend: hooks.armUnknownThenStallResend,
    armUnevaluated: unevaluatedHook(JOURNAL_RESENDS),
  };
}
