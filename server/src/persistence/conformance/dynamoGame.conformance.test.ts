// server/src/persistence/conformance/dynamoGame.conformance.test.ts
//
// ==================================================================
//  LIVE-5 L5-2: THE GAME-TABLE ADAPTERS AS CONFORMANCE SUBJECTS, ON DYNAMODB LOCAL
// ==================================================================
//
// Runs ONLY against a DynamoDB Local named by GS_DYNAMODB_LOCAL_ENDPOINT (`npm run test:dynamodb-local`), like the L5-1
// proof. Without one it FAILS with instructions rather than skipping.
//
// 1. Every game-table port -- log, GameRecord + join codes, holds, financial record, chain intents, wallet tickets --
//    runs its EXISTING conformance module with the DynamoDB adapter as a `dynamodb` subject: every capability the backend
//    requires is declared (the registration check refuses otherwise), and each subject's hooks aim scripted faults at
//    exactly the TransactWriteItems (or read) a case names.
// 2. THE WRITER FENCE is the production one. Each case's table holds the pool item (`POOL#<pool>`) at the harness's epoch;
//    `ctx.fence.takeOver()` takes the pool with L5-2's `takeOverPool` and re-claims every existing game with `claimGame`
//    -- what L5-3's newer task does. A store opened at an epoch carries it into every write's condition; nothing else.
//    Before a CURRENT writer's first write to a game this test stands in for L5-3's claim-at-load (a HEAD owned by the
//    current epoch, made through the admin client, outside the fault script); a stale writer gets no such help. Creation
//    writes (a record's, a money game's financial record) make their own HEAD.
// 3. DynamoDB-specific behaviour the modules cannot state backend-neutrally: TransactionInProgress, the size guards (a
//    request that cannot fit is never sent), the ownership primitives, the index items written in the same transaction
//    (DIR#, FINIDX#/FINKEYS, RELAYQ#, LIST#), and the byte-identical log export.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GetItemCommand, ListTablesCommand, PutItemCommand, ScanCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createDynamoDbClient, deadline, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../../aws/awsClients";
import { DIRKEYS_KEY, FINKEYS_KEY, gamePk, headKey, queryAll, readHead, SIZE_POLICY, type Item } from "../../aws/game/gameTable";
import { claimGame, readPool, releaseGame, takeOverPool } from "../../aws/game/ownership";
import { createDynamoLogStore, DYNAMO_LOG_MAX_BATCH } from "../../aws/game/dynamoLogStore";
import { createDynamoRecordStore } from "../../aws/game/dynamoRecordStore";
import { createDynamoHoldStore } from "../../aws/game/dynamoHoldStore";
import { createDynamoFinancialStore, financialIdentityKey } from "../../aws/game/dynamoFinancialStore";
import { createDynamoIntentStore } from "../../aws/game/dynamoIntentStore";
import { createDynamoTicketStore } from "../../aws/game/dynamoTicketStore";
import { createDynamoConductStore } from "../../aws/game/dynamoConductStore";
import { CONDUCT_CASE_FORMAT } from "../../conduct/conductCase";
import { CONDUCT_CASES, type ConductSubject } from "./conductStore.conformance";
import type { ResendTiming } from "../../aws/game/transact";
import { createFileLogStore } from "../../fileLogStore";
import { CHAIN_INTENT_FORMAT, confirmedIntent, heldIntent } from "../../escrow/chainIntents";
import { transitionFinancial } from "../../escrow/moneyLifecycle";
import { WALLET_TICKET_FILE_FORMAT } from "../../escrow/walletTicketFileStore";
import { FINANCIAL_CASES, INTENT_CASES, TICKET_CASES, type FinancialSubject, type IntentSubject, type TicketSubject } from "./escrowStores.conformance";
import { FaultScript, gate, type Gate } from "./faults";
import { entries, financial, gameId, gameRecord, grant, hold, intent, largeEntry, nextFinancial, nextIntent } from "./fixtures";
import { ConformanceTables, installFaults, newRunId, requireLocal } from "./dynamoLocal";
import { runConformance, type CaseContext } from "./harness";
import { LOG_CASES, type LogSubject } from "./logStore.conformance";
import { HOLD_CASES, RECORD_CASES, type HoldSubject, type Planted, type RecordSubject } from "./roomStores.conformance";
import { financialBytes, recordBytes } from "./subjects";

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
const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number): AttributeValue => ({ N: String(value) });
const POOL = "pool-a";
const QUEUE = "juno1relayerconformance";

/** Resends are real; their pacing is not (no test waits on a clock): at most two resends, no sleep. */
const TIMING: Partial<ResendTiming> = { maxResends: 2, windowMs: 60_000, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined };

after(async () => {
  await tables.dropAll();
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
/* One table per case, the production fence, and a takeover that is L5-3's                                   */
/* ------------------------------------------------------------------ */

interface CaseTable {
  readonly table: string;
  readonly client: DynamoDBClient;
}
const perCase = new WeakMap<CaseContext, CaseTable>();

async function scanHeads(table: string): Promise<string[]> {
  const out: string[] = [];
  let start: Item | undefined;
  do {
    const page = await admin.send(new ScanCommand({ TableName: table, ConsistentRead: true, FilterExpression: "sk = :head", ExpressionAttributeValues: { ":head": S("HEAD") }, ExclusiveStartKey: start }), { abortSignal: deadline() });
    for (const item of page.Items ?? []) out.push((item.pk?.S ?? "").slice("GAME#".length));
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return out;
}

async function caseTable(ctx: CaseContext): Promise<CaseTable> {
  const known = perCase.get(ctx);
  if (known !== undefined) return known;
  const table = await tables.create("game");
  const client = createDynamoDbClient(TARGET);
  await requireLocal(client);
  installFaults(client, ctx.faults);
  /* The pool, taken by its first task at the harness's epoch (L5-2's own primitive). */
  const first = await takeOverPool(admin, table, POOL, "task-1", 1);
  assert.deepEqual(first, { kind: "taken", epoch: ctx.fence.epoch });
  /* A takeover is what L5-3's newer task does: take the pool, then claim every game it serves. */
  ctx.fence.onTakeOver(async (epoch) => {
    const taken = await takeOverPool(admin, table, POOL, `task-${epoch}`, epoch);
    assert.deepEqual(taken, { kind: "taken", epoch }, "the pool epoch follows the harness's");
    for (const game of await scanHeads(table)) {
      const claimed = await claimGame(admin, table, game, { pool: POOL, epoch, task: `task-${epoch}` });
      assert.equal(claimed.kind, "claimed", `the newer task claims ${game}`);
    }
  });
  ctx.defer(async () => {
    client.destroy();
    await tables.drop(table);
  });
  const entry = { table, client };
  perCase.set(ctx, entry);
  return entry;
}

/** L5-3's claim-at-load, for a CURRENT writer's first write to a game: a HEAD owned by the current epoch, made if absent.
 *  A stale writer (its epoch no longer the harness's) is never helped: its writes meet the fence as they are. */
async function claimedForCurrent(ctx: CaseContext, epoch: number, game: string): Promise<void> {
  if (epoch !== ctx.fence.epoch) return;
  const { table } = await caseTable(ctx);
  try {
    await admin.send(
      new PutItemCommand({ TableName: table, Item: { ...headKey(game), owner_pool: S(POOL), pool_epoch: N(epoch), owner_task: S(`task-${epoch}`), log_next_index: N(0), log_bytes: N(0) }, ConditionExpression: "attribute_not_exists(pk)" }),
      { abortSignal: deadline() },
    );
  } catch (error) {
    if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
  }
}

const options = async (ctx: CaseContext) => {
  const { client, table } = await caseTable(ctx);
  return { client, table, fence: { pool: POOL, epoch: ctx.fence.epoch }, timing: TIMING, pageSize: 5 };
};

async function body(ctx: CaseContext, pk: string, sk: string): Promise<string | null> {
  const { table } = await caseTable(ctx);
  const answer = await admin.send(new GetItemCommand({ TableName: table, Key: { pk: S(pk), sk: S(sk) }, ConsistentRead: true }), { abortSignal: deadline() });
  return answer.Item?.body?.S ?? null;
}

async function putRaw(ctx: CaseContext, item: Item): Promise<void> {
  const { table } = await caseTable(ctx);
  await admin.send(new PutItemCommand({ TableName: table, Item: item }), { abortSignal: deadline() });
}

/* ---- the fault hooks: every one aims at the TransactWriteItems (or read) that names its item ---- */

const TX = "TransactWriteItemsCommand";
type Match = (detail: string) => boolean;
const names = (...parts: string[]): Match => (detail) => parts.every((part) => detail.includes(`{"S":"${part}"}`));

function faultHooks(match: (ctx: CaseContext, key: string) => Match) {
  return {
    stallNextWrite(ctx: CaseContext, key: string): Gate {
      const stall = gate();
      ctx.faults.add({ op: TX, where: match(ctx, key), action: { kind: "stall", gate: stall }, label: "the write stalls before it is sent" });
      return stall;
    },
    armLostAnswer(ctx: CaseContext, key: string): void {
      ctx.faults.add({ op: TX, where: match(ctx, key), action: { kind: "lose-answer" }, label: "the write lands, its answer is lost" });
    },
    armTransientFailure(ctx: CaseContext, key: string): void {
      ctx.faults.add({ op: TX, where: match(ctx, key), action: { kind: "fail" }, label: "the write is throttled" });
    },
    armUnknownThenStallResend(ctx: CaseContext, key: string, landed: boolean): Gate {
      const resend = gate();
      ctx.faults.add({ op: TX, where: match(ctx, key), nth: 1, action: landed ? { kind: "lose-answer" } : { kind: "fail", code: "TimeoutError" }, label: landed ? "the write lands, its answer is lost" : "the write times out before it is sent" });
      ctx.faults.add({ op: TX, where: match(ctx, key), nth: 2, action: { kind: "stall", gate: resend }, label: "the resend stalls" });
      return resend;
    },
    armUnevaluated(ctx: CaseContext, key: string, landed: boolean): void {
      ctx.faults.add({ op: TX, where: match(ctx, key), nth: 1, action: landed ? { kind: "lose-answer" } : { kind: "fail", code: "TimeoutError" }, label: landed ? "the write lands, its answer is lost" : "the write times out before it is sent" });
      ctx.faults.add({ op: TX, where: match(ctx, key), nth: 2, action: { kind: "fail", code: "TimeoutError" }, label: "the first resend times out unsent" });
      ctx.faults.add({ op: TX, where: match(ctx, key), nth: 3, action: { kind: "fail", code: "TimeoutError" }, label: "the second resend times out unsent" });
    },
    writeTokens(ctx: CaseContext, key: string): string[] {
      const where = match(ctx, key);
      return ctx.faults.calls.filter((call) => call.op === TX && where(call.detail)).map((call) => (JSON.parse(call.detail) as { ClientRequestToken?: string }).ClientRequestToken ?? "");
    },
    /** The attempt lands and its answer is lost; both resends time out; then the settling read `read` (its `nth` matching
     *  call) fails: an outcome no one can settle. */
    unresolved(ctx: CaseContext, key: string, read: { readonly op: string; readonly where: Match; readonly nth: number }): void {
      ctx.faults.add({ op: TX, where: match(ctx, key), nth: 1, action: { kind: "lose-answer" }, label: "the write lands, its answer is lost" });
      ctx.faults.add({ op: TX, where: match(ctx, key), nth: 2, action: { kind: "fail", code: "TimeoutError" }, label: "the first resend times out" });
      ctx.faults.add({ op: TX, where: match(ctx, key), nth: 3, action: { kind: "fail", code: "TimeoutError" }, label: "the second resend times out" });
      ctx.faults.add({ op: read.op, where: read.where, nth: read.nth, action: { kind: "fail", code: "TimeoutError" }, label: "the settling read fails" });
    },
  };
}

/* ================================================================== */
/*  1. The subjects                                                    */
/* ================================================================== */

const DYNAMO_CAPABILITIES = ["durable", "fence", "fence-in-write", "cas-in-write", "plant", "stall-write", "idempotency-token", "inject-lost-answer", "inject-transient-failure", "inject-unevaluated"] as const;

/* ---- log ---- */

const logHooks = faultHooks((_ctx, room) => (detail) => names(gamePk(room))(detail) && detail.includes('"S":"LOG#'));
const chatMatch = (room: string): Match => (detail) => names(gamePk(room))(detail) && detail.includes('"S":"CHAT#');

const dynamoLogSubject: LogSubject = {
  name: "dynamodb (createDynamoLogStore)",
  backend: "dynamodb",
  capabilities: [...DYNAMO_CAPABILITIES, "inject-unresolved"],
  maxBatchEntries: DYNAMO_LOG_MAX_BATCH,
  async open(ctx) {
    const epoch = ctx.fence.epoch;
    const store = createDynamoLogStore(await options(ctx));
    return {
      ...store,
      async appendBatch(room, batch) {
        await claimedForCurrent(ctx, epoch, room);
        return store.appendBatch(room, batch);
      },
      async appendLog(room, batch) {
        await claimedForCurrent(ctx, epoch, room);
        return store.appendLog(room, batch);
      },
      async appendChat(room, entry) {
        await claimedForCurrent(ctx, epoch, room);
        return store.appendChat(room, entry);
      },
    };
  },
  /* The stored items exactly (not the validated export: damage must be comparable too). */
  async stored(ctx, room) {
    const { table } = await caseTable(ctx);
    const items = await queryAll(admin, table, gamePk(room), { prefix: "LOG#" });
    return items.length === 0 ? null : items.map((item) => `${item.sk?.S}\t${item.line?.S ?? "<no line>"}\n`).join("");
  },
  /* What another writer (or damage) left: one item per line, a HEAD counting them. */
  async plant(ctx, room, bytes) {
    const lines = bytes.toString("utf8").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const [at, line] of lines.entries()) await putRaw(ctx, { pk: S(gamePk(room)), sk: S(`LOG#${String(at).padStart(10, "0")}`), line: S(line) });
    await putRaw(ctx, { ...headKey(room), owner_pool: S(POOL), pool_epoch: N(ctx.fence.epoch), log_next_index: N(lines.length), log_bytes: N(bytes.length) });
  },
  stallNextWrite: logHooks.stallNextWrite,
  armLostAnswer: logHooks.armLostAnswer,
  armTransientFailure: logHooks.armTransientFailure,
  armUnknownThenStallResend: logHooks.armUnknownThenStallResend,
  armUnevaluated: logHooks.armUnevaluated,
  writeTokens: logHooks.writeTokens,
  armUnresolvedWrite(ctx, room) {
    logHooks.unresolved(ctx, room, { op: "GetItemCommand", where: names(gamePk(room), "HEAD"), nth: 1 });
  },
  stallNextChat(ctx, room) {
    const stall = gate();
    ctx.faults.add({ op: TX, where: chatMatch(room), action: { kind: "stall", gate: stall }, label: "the chat line stalls before it is sent" });
    return stall;
  },
};

/* ---- GameRecord + join codes ---- */

const recordHooks = faultHooks((_ctx, game) => names(gamePk(game), "META"));

const dynamoRecordSubject: RecordSubject = {
  name: "dynamodb (createDynamoRecordStore)",
  backend: "dynamodb",
  capabilities: [...DYNAMO_CAPABILITIES, "validates-shape"],
  async open(ctx) {
    const epoch = ctx.fence.epoch;
    const store = createDynamoRecordStore(await options(ctx));
    return {
      ...store,
      async put(record, expected) {
        /* A creation makes its own HEAD (pool-fenced); an update needs the game claimed. */
        if (expected !== null) await claimedForCurrent(ctx, epoch, record.game_id);
        return store.put(record, expected);
      },
    };
  },
  async stored(ctx, game) {
    return body(ctx, gamePk(game), "META");
  },
  async plant(ctx, game, what) {
    await putRaw(ctx, { pk: S(gamePk(game)), sk: S("META"), body: S(recordBytes(game, what).trimEnd()), record_version: N(1) });
  },
  ...recordHooks,
  stallNextCodeClaim(ctx, code) {
    const stall = gate();
    ctx.faults.add({ op: TX, where: names(`JOIN#${code}`), action: { kind: "stall", gate: stall }, label: "the code claim stalls before it is sent" });
    return stall;
  },
};

/* ---- holds ---- */

const holdCreate = (game: string): Match => (detail) => names(gamePk(game), "HOLD")(detail) && !detail.includes('"S":"HOLDREL#');
const holdAny = (game: string): Match => (detail) => names(gamePk(game))(detail) && detail.includes('"S":"HOLD');
const holdHooks = faultHooks((_ctx, game) => holdCreate(game));

const dynamoHoldSubject: HoldSubject = {
  name: "dynamodb (createDynamoHoldStore)",
  backend: "dynamodb",
  capabilities: [...DYNAMO_CAPABILITIES, "validates-shape"],
  async open(ctx) {
    const epoch = ctx.fence.epoch;
    const store = createDynamoHoldStore(await options(ctx));
    return {
      ...store,
      async create(held) {
        await claimedForCurrent(ctx, epoch, held.game_id);
        return store.create(held);
      },
      async release(game, release) {
        await claimedForCurrent(ctx, epoch, game);
        return store.release(game, release);
      },
    };
  },
  async stored(ctx, game) {
    return body(ctx, gamePk(game), "HOLD");
  },
  async releasedCopies(ctx, game) {
    return createDynamoHoldStore({ ...(await options(ctx)), client: admin }).releasedCopies(game);
  },
  async plant(ctx, game) {
    await putRaw(ctx, { pk: S(gamePk(game)), sk: S("HOLD"), body: S('{"format":"gs-game-hold",') });
    await putRaw(ctx, { pk: S("LIST#hold"), sk: S(game), game_id: S(game) });
  },
  ...holdHooks,
  /* A release is a write on the game too: its token is part of the game's hold writes. */
  writeTokens(ctx, game) {
    const where = holdAny(game);
    return ctx.faults.calls.filter((call) => call.op === TX && where(call.detail)).map((call) => (JSON.parse(call.detail) as { ClientRequestToken?: string }).ClientRequestToken ?? "");
  },
  /* The game's next hold write, create or release. */
  armUnevaluated: faultHooks((_ctx, game) => holdAny(game)).armUnevaluated,
  stallNextRelease(ctx, game) {
    const stall = gate();
    ctx.faults.add({ op: TX, where: (detail) => names(gamePk(game))(detail) && detail.includes('"S":"HOLDREL#'), action: { kind: "stall", gate: stall }, label: "the release stalls before it is sent" });
    return stall;
  },
};

/* ---- financial record ---- */

const finHooks = faultHooks((_ctx, game) => names(gamePk(game), "FIN"));

const dynamoFinancialSubject: FinancialSubject = {
  name: "dynamodb (createDynamoFinancialStore)",
  backend: "dynamodb",
  capabilities: [...DYNAMO_CAPABILITIES, "validates-shape"],
  async open(ctx) {
    const epoch = ctx.fence.epoch;
    const store = createDynamoFinancialStore(await options(ctx));
    return {
      ...store,
      /* The creation makes its own HEAD (pool-fenced); a put needs the game claimed. */
      async put(next, expected) {
        await claimedForCurrent(ctx, epoch, next.game_id);
        return store.put(next, expected);
      },
    };
  },
  async stored(ctx, game) {
    return body(ctx, gamePk(game), "FIN");
  },
  async plant(ctx, game, what) {
    await putRaw(ctx, { pk: S(gamePk(game)), sk: S("FIN"), body: S(financialBytes(game, what)) });
  },
  ...finHooks,
};

/* ---- chain intents (key: `<game>/<intent>`) ---- */

const split = (key: string): [string, string] => key.split("/") as [string, string];
const intentHooks = faultHooks((_ctx, key) => names(`INTENT#${split(key)[1]}`));

const dynamoIntentSubject: IntentSubject = {
  name: "dynamodb (createDynamoIntentStore)",
  backend: "dynamodb",
  capabilities: [...DYNAMO_CAPABILITIES, "validates-shape"],
  differences: { "INT-07-older": "CHAIN_INTENT_SCHEMA is 1, the first schema: no older intent can exist to plant (the memory marker exercises the class; the same reviewed difference as the file store)" },
  async open(ctx) {
    const epoch = ctx.fence.epoch;
    const store = createDynamoIntentStore({ ...(await options(ctx)), relayQueue: QUEUE });
    return {
      ...store,
      async create(record) {
        await claimedForCurrent(ctx, epoch, record.game_id);
        return store.create(record);
      },
      async put(next, expected) {
        await claimedForCurrent(ctx, epoch, next.game_id);
        return store.put(next, expected);
      },
    };
  },
  async stored(ctx, key) {
    const [game, id] = split(key);
    return body(ctx, gamePk(game), `INTENT#${id}`);
  },
  async plant(ctx, game, id, what) {
    const text = what === "corrupt" ? `{"format":"${CHAIN_INTENT_FORMAT}",` : JSON.stringify({ format: CHAIN_INTENT_FORMAT, schema: 9, game_id: game, intent_id: id });
    await putRaw(ctx, { pk: S(gamePk(game)), sk: S(`INTENT#${id}`), body: S(text) });
  },
  ...intentHooks,
};

/* ---- wallet tickets ---- */

const ticketHooks = faultHooks((_ctx, game) => names(gamePk(game), "TICKETS"));

const dynamoTicketSubject: TicketSubject = {
  name: "dynamodb (createDynamoTicketStore)",
  backend: "dynamodb",
  capabilities: [...DYNAMO_CAPABILITIES, "validates-shape", "inject-unresolved"],
  async open(ctx) {
    const epoch = ctx.fence.epoch;
    const store = createDynamoTicketStore(await options(ctx));
    return {
      ...store,
      async put(game, document, expected) {
        await claimedForCurrent(ctx, epoch, game);
        return store.put(game, document, expected);
      },
    };
  },
  async stored(ctx, game) {
    return body(ctx, gamePk(game), "TICKETS");
  },
  async plant(ctx, game, what) {
    if (what === "corrupt") {
      await putRaw(ctx, { pk: S(gamePk(game)), sk: S("TICKETS"), body: S(`{"format":"${WALLET_TICKET_FILE_FORMAT}",`) });
      return;
    }
    const { proof: _p, consent_keys: _c, relinked_from: _r, create_floor: _f, ...protocol2 } = grant(1, 1, 1);
    await putRaw(ctx, { pk: S(gamePk(game)), sk: S("TICKETS"), body: S(JSON.stringify({ format: WALLET_TICKET_FILE_FORMAT, version: 1, game_id: game, document: { frozen_at: null, grants: [{ ...protocol2, game_id: game }] } })), version: N(1) });
  },
  ...ticketHooks,
  /* The put reads the ledger first (call 1); the settling read is call 2. */
  armUnresolvedWrite(ctx, game) {
    ticketHooks.unresolved(ctx, game, { op: "GetItemCommand", where: names(gamePk(game), "TICKETS"), nth: 2 });
  },
};

runConformance("log", [dynamoLogSubject], LOG_CASES);
runConformance("GameRecord", [dynamoRecordSubject], RECORD_CASES);
runConformance("hold", [dynamoHoldSubject], HOLD_CASES);
runConformance("financial record", [dynamoFinancialSubject], FINANCIAL_CASES);
runConformance("chain intent", [dynamoIntentSubject], INTENT_CASES);
runConformance("wallet ticket", [dynamoTicketSubject], TICKET_CASES);

/* ---- Phase 3 (P3-N032): conduct review cases (`CONDUCT#<case>/CASE`, POOL-fenced: no game is claimed for them) ---- */

const conductHooks = faultHooks((_ctx, caseId) => names(`CONDUCT#${caseId}`, "CASE"));

const dynamoConductSubject: ConductSubject = {
  name: "dynamodb (createDynamoConductStore)",
  backend: "dynamodb",
  capabilities: [...DYNAMO_CAPABILITIES, "validates-shape"],
  async open(ctx) {
    return createDynamoConductStore(await options(ctx));
  },
  async stored(ctx, caseId) {
    return body(ctx, `CONDUCT#${caseId}`, "CASE");
  },
  async plant(ctx, caseId, what) {
    if (what === "corrupt") await putRaw(ctx, { pk: S(`CONDUCT#${caseId}`), sk: S("CASE"), body: S(`{"format":"${CONDUCT_CASE_FORMAT}",`) });
    else await putRaw(ctx, { pk: S(`CONDUCT#${caseId}`), sk: S("CASE"), body: S(JSON.stringify({ format: CONDUCT_CASE_FORMAT, version: 99, case_id: caseId })), revision: N(1) });
    await putRaw(ctx, { pk: S("LIST#conduct"), sk: S(caseId), case_id: S(caseId) });
  },
  ...conductHooks,
};

runConformance("conduct case", [dynamoConductSubject], CONDUCT_CASES);

/* ================================================================== */
/*  2-3. What only a DynamoDB adapter can be asked                     */
/* ================================================================== */

interface Bench {
  readonly table: string;
  readonly client: DynamoDBClient;
  readonly faults: FaultScript;
  readonly fence: { readonly pool: string; readonly epoch: number };
}

async function bench(label: string): Promise<Bench> {
  const table = await tables.create(label);
  const client = createDynamoDbClient(TARGET);
  await requireLocal(client);
  const faults = new FaultScript();
  installFaults(client, faults);
  const taken = await takeOverPool(admin, table, POOL, "task-1", 1);
  assert.deepEqual(taken, { kind: "taken", epoch: 1 });
  return { table, client, faults, fence: { pool: POOL, epoch: 1 } };
}

async function own(b: Bench, game: string): Promise<void> {
  await admin.send(new PutItemCommand({ TableName: b.table, Item: { ...headKey(game), owner_pool: S(POOL), pool_epoch: N(b.fence.epoch), log_next_index: N(0), log_bytes: N(0) } }), { abortSignal: deadline() });
}

const raw = async (b: Bench, pk: string, sk: string): Promise<Item | null> =>
  (await admin.send(new GetItemCommand({ TableName: b.table, Key: { pk: S(pk), sk: S(sk) }, ConsistentRead: true }), { abortSignal: deadline() })).Item ?? null;

describe("L5-2 DynamoDB game table: the write engine, the size guards and the index items", () => {
  const benches: Bench[] = [];
  const open = async (label: string) => {
    const b = await bench(label);
    benches.push(b);
    return b;
  };
  after(async () => {
    for (const b of benches) {
      b.client.destroy();
      await tables.drop(b.table);
    }
  });

  test("TransactionInProgress is waited out with the SAME token, and the write lands once", async () => {
    const b = await open("inprogress");
    const G = gameId(1);
    await own(b, G);
    const store = createDynamoLogStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    assert.equal((await store.appendBatch(G, entries(0, 1))).kind, "committed");
    const where = names(gamePk(G));
    b.faults.add({ op: TX, where, nth: 1, action: { kind: "lose-answer" }, label: "lands, answer lost" });
    b.faults.add({ op: TX, where, nth: 2, action: { kind: "fail", code: "TransactionInProgressException" }, label: "still in progress" });
    assert.deepEqual(await store.appendBatch(G, entries(1, 2)), { kind: "committed", redone: true });
    const attempts = b.faults.calls.filter((call) => call.op === TX && where(call.detail)).slice(-3).map((call) => (JSON.parse(call.detail) as { ClientRequestToken: string }).ClientRequestToken);
    assert.equal(new Set(attempts).size, 1, "three sends, one token");
    assert.deepEqual((await store.loadLog(G)).map((entry) => entry.index), [0, 1, 2]);
    assert.deepEqual(b.faults.unfired(), []);
  });

  test("a throttled resend after an unknown outcome proves nothing: the engine keeps resending the same request", async () => {
    const b = await open("throttledresend");
    const G = gameId(2);
    await own(b, G);
    const store = createDynamoFinancialStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    assert.equal((await store.create(financial(2))).outcome.kind, "committed");
    const where = names(gamePk(G), "FIN");
    b.faults.add({ op: TX, where, nth: 1, action: { kind: "lose-answer" }, label: "lands, answer lost" });
    b.faults.add({ op: TX, where, nth: 2, action: { kind: "fail" }, label: "the resend is throttled" });
    const v2 = nextFinancial(financial(2), 5);
    assert.deepEqual(await store.put(v2, 1), { kind: "committed", redone: true }, "the third send (the same token) is answered success: the first landed");
    assert.deepEqual(await store.load(G), v2);
    assert.deepEqual(b.faults.unfired(), []);
  });

  test("an unknown outcome whose resends never get an evaluated answer, and whose write is not visible, is UNCERTAIN -- never 'nothing was written'", async () => {
    const b = await open("neverevaluated");
    const G = gameId(3);
    await own(b, G);
    const store = createDynamoRecordStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    const v1 = gameRecord(3);
    assert.equal((await store.put(v1, null)).kind, "committed");
    const where = names(gamePk(G), "META");
    for (const nth of [1, 2, 3]) b.faults.add({ op: TX, where, nth, action: { kind: "fail", code: "TimeoutError" }, label: `send ${nth} times out unsent` });
    const outcome = await store.put({ ...v1, record_version: 2, last_activity_at: v1.last_activity_at + 1 }, 1);
    assert.equal(outcome.kind, "uncertain", JSON.stringify(outcome));
    assert.deepEqual(b.faults.unfired(), []);
  });

  test("size guards: a batch over the transaction bound, an entry item over the item bound and an oversized record are refused DEFINITE -- and nothing is sent", async () => {
    const b = await open("sizes");
    const G = gameId(4);
    await own(b, G);
    const log = createDynamoLogStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    assert.equal((await log.appendBatch(G, entries(0, 1))).kind, "committed");
    const sent = () => b.faults.calls.filter((call) => call.op === TX).length;
    const before = sent();
    assert.equal((await log.appendBatch(G, entries(1, DYNAMO_LOG_MAX_BATCH + 1))).kind, "definite");
    assert.equal((await log.appendBatch(G, [largeEntry(1, SIZE_POLICY.itemBytes + 1024)])).kind, "definite");
    const bulky = Array.from({ length: 12 }, (_, k) => largeEntry(1 + k, 320 * 1024));
    assert.equal((await log.appendBatch(G, bulky)).kind, "definite", "twelve 320 KiB entries: over the transaction's byte bound");
    const fin = createDynamoFinancialStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    const huge = { ...financial(4), transitions: Array.from({ length: 4000 }, (_, k) => ({ from: "funding", to: "funding", at: k, why: "x".repeat(100) })) } as unknown as ReturnType<typeof financial>;
    assert.equal((await fin.create(huge)).outcome.kind, "definite");
    assert.equal(sent(), before, "no oversized request was ever sent");
    assert.deepEqual((await log.loadLog(G)).map((entry) => entry.index), [0]);
  });

  test("a batch AT the DynamoDB bound commits in one transaction (the HEAD and every entry together)", async () => {
    const b = await open("atbound");
    const G = gameId(5);
    await own(b, G);
    const log = createDynamoLogStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    assert.equal((await log.appendBatch(G, entries(0, DYNAMO_LOG_MAX_BATCH))).kind, "committed");
    assert.equal((await readHead(admin, b.table, G))?.log_next_index, DYNAMO_LOG_MAX_BATCH);
    assert.equal(b.faults.calls.filter((call) => call.op === TX).length, 1);
  });

  test("the log's export is byte-identical to the file store's log for the same batches (every payload byte kept)", async () => {
    const b = await open("export");
    const G = gameId(6);
    await own(b, G);
    const dynamo = createDynamoLogStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-l5-2-export-"));
    try {
      const file = createFileLogStore(dir, { warn: () => undefined });
      const batches = [entries(0, 3), [largeEntry(3, 30 * 1024)], entries(4, 7)];
      for (const batch of batches) {
        assert.equal((await dynamo.appendBatch(G, batch)).kind, "committed");
        assert.equal((await file.appendBatch(G, batch)).kind, "committed");
      }
      const fileBytes = fs.readFileSync(path.join(dir, `${G}.log.jsonl`));
      assert.ok((await dynamo.exportLog(G)).equals(fileBytes), "the export equals the file log, byte for byte");
      assert.deepEqual(await dynamo.loadLog(G), await file.loadLog(G));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("index items move in the same transaction: DIR# and DIRKEYS with a record; FINIDX# and FINKEYS with a money game, FINIDX# gone when it closes", async () => {
    const b = await open("indexes");
    const records = createDynamoRecordStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    const record = gameRecord(7);
    assert.equal((await records.put(record, null)).kind, "committed");
    const month = new Date(record.created_at).toISOString().slice(0, 7).replace("-", "");
    assert.deepEqual((await raw(b, "DIRKEYS", "DIRKEYS"))?.months?.SS, [month]);
    assert.deepEqual(await records.list(), [gameId(7)]);
    assert.equal((await readHead(admin, b.table, gameId(7)))?.owner_pool, POOL, "the record's creation made the game's HEAD, owned by its writer");
    void DIRKEYS_KEY;

    const fin = createDynamoFinancialStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    const G = gameId(8);
    const v1 = financial(8);
    assert.equal((await fin.create(v1)).outcome.kind, "committed", "a money game's financial record may be its birth (made before the GameRecord)");
    const identity = financialIdentityKey(v1) as string;
    assert.deepEqual(await fin.identityKeys(), [identity]);
    assert.deepEqual(await fin.openGames(identity), [G]);
    assert.deepEqual((await raw(b, "FINKEYS", "FINKEYS"))?.keys?.SS, [identity]);
    void FINKEYS_KEY;
    const moved = (decision: ReturnType<typeof transitionFinancial>) => {
      assert.equal(decision.kind, "moved", JSON.stringify(decision));
      return (decision as { next: ReturnType<typeof financial> }).next;
    };
    const held = moved(transitionFinancial(v1, { kind: "hold", at: 10, code: "game-held", detail: "the game itself is held" }));
    assert.equal((await fin.put(held, 1)).kind, "committed");
    assert.deepEqual(await fin.openGames(identity), [G], "a held money game is still open");
    const other = financial(11);
    assert.equal((await fin.create(other)).outcome.kind, "committed");
    const cancelled = moved(transitionFinancial(other, { kind: "cancel-before-deal", at: 12 }));
    assert.equal(cancelled.phase, "cancelled");
    assert.equal((await fin.put(cancelled, 1)).kind, "committed");
    assert.deepEqual(await fin.openGames(identity), [G], "the cancelling write removed its open-game index item, in the same transaction");
    assert.equal(await raw(b, `FINIDX#${identity}`, gamePk(gameId(11))), null);
    assert.deepEqual(await fin.identityKeys(), [identity], "FINKEYS never forgets a key");
  });

  test("an intent is created WITH its relay-queue item; the queue item goes only when the intent is confirmed or superseded (a held intent keeps it)", async () => {
    const b = await open("relayq");
    const G = gameId(9);
    await own(b, G);
    const store = createDynamoIntentStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING, relayQueue: QUEUE });
    const a = intent(9, 1, 100);
    const c = intent(9, 2, 200);
    assert.equal((await store.create(a)).kind, "created");
    assert.equal((await store.create(c)).kind, "created");
    assert.deepEqual((await store.relayQueue()).map((entry) => entry.intent_id), [a.intent_id, c.intent_id], "oldest first");
    const heldA = heldIntent(a, "gas", "absurd gas", 300);
    assert.equal((await store.put(heldA, 1)).kind, "committed");
    assert.equal((await store.relayQueue()).length, 2, "a held intent keeps its queue item (it may still carry a live attempt)");
    const confirmedC = confirmedIntent(c, "chain-state", null, "10", "seen on chain", 400);
    assert.equal((await store.put(confirmedC, 1)).kind, "committed");
    assert.deepEqual((await store.relayQueue()).map((entry) => entry.intent_id), [a.intent_id], "the confirmed intent left the queue in the same write");
    assert.equal((await store.put(nextIntent(heldA, 500), 2)).kind, "committed");
    assert.equal((await store.relayQueue()).length, 1);
  });

  test("ownership primitives: takeOverPool moves the epoch once per task (a lost answer is settled by a read); claimGame is pool-fenced, never makes a game, never lowers an epoch; releaseGame frees only one's own", async () => {
    const b = await open("primitives");
    const G = gameId(10);
    assert.deepEqual(await claimGame(admin, b.table, G, { pool: POOL, epoch: 1, task: "task-1" }), { kind: "absent" }, "a claim never creates a game");
    await own(b, G);
    assert.deepEqual(await takeOverPool(admin, b.table, "pool-b", "b-1", 1), { kind: "taken", epoch: 1 });
    assert.equal((await claimGame(admin, b.table, G, { pool: "pool-b", epoch: 1, task: "b-1" })).kind, "owned-elsewhere", "a game owned by a live pool is never taken by another");
    assert.deepEqual(await claimGame(admin, b.table, G, { pool: POOL, epoch: 99, task: "never" }), { kind: "stale-pool" }, "an epoch the pool never reached claims nothing (review M-1)");
    const faults = new FaultScript([{ op: "UpdateItemCommand", nth: 1, action: { kind: "lose-answer" }, label: "the takeover lands, its answer is lost" }]);
    const client = createDynamoDbClient(TARGET);
    installFaults(client, faults);
    try {
      assert.deepEqual(await takeOverPool(client, b.table, POOL, "task-2", 2), { kind: "taken", epoch: 2 }, "the lost answer is settled by the read: epoch 2 is task-2's");
      assert.deepEqual(faults.unfired(), []);
    } finally {
      client.destroy();
    }
    assert.deepEqual(await readPool(admin, b.table, POOL), { writer_epoch: 2, writer_task: "task-2" });
    const claimed = await claimGame(admin, b.table, G, { pool: POOL, epoch: 2, task: "task-2" });
    assert.equal(claimed.kind, "claimed");
    assert.deepEqual(await claimGame(admin, b.table, G, { pool: POOL, epoch: 2, task: "task-2" }), claimed, "a repeated claim is idempotent");
    assert.deepEqual(await claimGame(admin, b.table, G, { pool: POOL, epoch: 1, task: "task-1" }), { kind: "stale-pool" }, "an older task of the pool never takes a game back");
    assert.equal(await releaseGame(admin, b.table, G, { pool: POOL, epoch: 1 }), false, "a stale writer cannot release it");
    assert.equal(await releaseGame(admin, b.table, G, { pool: POOL, epoch: 2 }), true);
    assert.equal((await readHead(admin, b.table, G))?.owner_pool, "#none");
    assert.deepEqual(await claimGame(admin, b.table, G, { pool: POOL, epoch: 1, task: "task-1" }), { kind: "stale-pool" }, "a stale task cannot claim even a RELEASED game (review M-1)");
    assert.equal((await readHead(admin, b.table, G))?.owner_pool, "#none", "and nothing moved");
    assert.equal((await claimGame(admin, b.table, G, { pool: "pool-b", epoch: 1, task: "b-1" })).kind, "claimed", "a released game can be claimed by another pool's newest task");
    const hold1 = createDynamoHoldStore({ client: b.client, table: b.table, fence: { pool: POOL, epoch: 2 }, timing: TIMING });
    assert.equal((await hold1.create(hold(10))).outcome.kind, "definite", "pool-a's writes to a game pool-b claimed are fenced");
  });

  test("a creation never takes a game another pool owns, or one that was released: the record's and the money game's births are fenced by the HEAD they meet", async () => {
    const b = await open("foreignhead");
    const records = createDynamoRecordStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    const fin = createDynamoFinancialStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    const foreign = gameId(20);
    await admin.send(new PutItemCommand({ TableName: b.table, Item: { ...headKey(foreign), owner_pool: S("pool-b"), pool_epoch: N(1), log_next_index: N(0), log_bytes: N(0) } }), { abortSignal: deadline() });
    assert.equal((await records.put(gameRecord(20), null)).kind, "definite");
    assert.equal((await fin.create(financial(20))).outcome.kind, "definite");
    const released = gameId(21);
    await admin.send(new PutItemCommand({ TableName: b.table, Item: { ...headKey(released), owner_pool: S("#none"), pool_epoch: N(1), log_next_index: N(0), log_bytes: N(0) } }), { abortSignal: deadline() });
    assert.equal((await records.put(gameRecord(21), null)).kind, "definite", "a released game is claimed first (L5-3), never re-born");
    assert.equal((await fin.create(financial(21))).outcome.kind, "definite");
    for (const game of [foreign, released]) {
      assert.equal(await raw(b, gamePk(game), "META"), null);
      assert.equal(await raw(b, gamePk(game), "FIN"), null);
    }
    assert.equal((await readHead(admin, b.table, foreign))?.owner_pool, "pool-b", "the foreign HEAD is untouched");
  });

  test("the DynamoDB log's own consistency: a torn batch, a HEAD that disagrees with its items, and an entry stored at another index are CORRUPT -- served, exported and appended to never, left exactly as found", async () => {
    const b = await open("logdamage");
    const log = createDynamoLogStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    const line = (index: number, first: number, last: number) => JSON.stringify({ ...entries(index, 1)[0], batch: [first, last] });
    const plant = async (room: string, lines: ReadonlyArray<readonly [number, string]>, headCount: number) => {
      for (const [at, text] of lines) await admin.send(new PutItemCommand({ TableName: b.table, Item: { pk: S(gamePk(room)), sk: S(`LOG#${String(at).padStart(10, "0")}`), line: S(text) } }), { abortSignal: deadline() });
      await admin.send(new PutItemCommand({ TableName: b.table, Item: { ...headKey(room), owner_pool: S(POOL), pool_epoch: N(1), log_next_index: N(headCount), log_bytes: N(0) } }), { abortSignal: deadline() });
    };
    const torn = gameId(30);
    await plant(torn, [[0, line(0, 0, 1)], [1, line(1, 0, 1)], [2, line(2, 2, 3)]], 3);
    /* The same torn batch with a HEAD that counts only the clean prefix: the torn tail alone must refuse it. */
    const tornQuiet = gameId(34);
    await plant(tornQuiet, [[0, line(0, 0, 1)], [1, line(1, 0, 1)], [2, line(2, 2, 3)]], 2);
    const behind = gameId(31);
    await plant(behind, [[0, line(0, 0, 0)], [1, line(1, 1, 1)], [2, line(2, 2, 2)]], 5);
    const misplaced = gameId(32);
    await plant(misplaced, [[0, line(0, 0, 0)], [1, line(1, 1, 1)], [7, line(2, 2, 2)]], 3);
    for (const room of [torn, tornQuiet, behind, misplaced]) {
      const before = await queryAll(admin, b.table, gamePk(room));
      await assert.rejects(log.loadLog(room), (error: Error) => error.name === "StoreCorruptError", room);
      await assert.rejects(log.exportLog(room), (error: Error) => error.name === "StoreCorruptError", `${room}: a damaged log is never exported as history`);
      assert.equal((await log.appendBatch(room, entries(3, 1))).kind, "definite");
      assert.deepEqual(await queryAll(admin, b.table, gamePk(room)), before, `${room} is left exactly as found`);
    }
  });

  test("a stored line is served and exported exactly as stored (a valid entry in a non-canonical spelling is never normalised)", async () => {
    const b = await open("verbatim");
    const room = gameId(33);
    const text = `{"index":0,  "id":"s0-0" ,"actor":"SERVER","payload":"{\\"a\\": 1}","at":1,"batch":[0,0]}`;
    await admin.send(new PutItemCommand({ TableName: b.table, Item: { pk: S(gamePk(room)), sk: S("LOG#0000000000"), line: S(text) } }), { abortSignal: deadline() });
    await admin.send(new PutItemCommand({ TableName: b.table, Item: { ...headKey(room), owner_pool: S(POOL), pool_epoch: N(1), log_next_index: N(1), log_bytes: N(0) } }), { abortSignal: deadline() });
    const log = createDynamoLogStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    const [entry] = await log.loadLog(room);
    assert.equal((entry as unknown as { payload: string }).payload, '{"a": 1}', "the payload's bytes are the stored ones");
    assert.equal((await log.exportLog(room)).toString("utf8"), `${text}\n`, "the export is the stored line, byte for byte");
  });

  test("every replace and delete names the EXACT item it read: an item swapped in at the same version meanwhile (another build's, damage) is never overwritten or deleted -- with or without an attempt token", async () => {
    const b = await open("observed");
    const swap = async (pk: string, sk: string, change: (item: Item) => Item) => {
      const item = (await raw(b, pk, sk)) as Item;
      await admin.send(new PutItemCommand({ TableName: b.table, Item: change(item) }), { abortSignal: deadline() });
      return (await raw(b, pk, sk)) as Item;
    };
    const stallOn = (...parts: string[]) => {
      const stall = gate();
      b.faults.add({ op: TX, where: names(...parts), action: { kind: "stall", gate: stall }, label: `stall ${parts.join(" ")}` });
      return stall;
    };
    const race = async <T>(stall: Gate, pending: Promise<T>, pk: string, sk: string, change: (item: Item) => Item): Promise<{ readonly outcome: T; readonly swapped: Item }> => {
      await stall.reached;
      const swapped = await swap(pk, sk, change);
      stall.release();
      return { outcome: await pending, swapped };
    };
    const otherToken = (item: Item): Item => ({ ...item, att: S("someone-elses-token"), atts: { L: [S("someone-elses-token")] } });
    const noToken = (item: Item): Item => {
      const { att: _a, atts: _b, ...rest } = item;
      return rest;
    };

    const records = createDynamoRecordStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    const r = gameRecord(40);
    assert.equal((await records.put(r, null)).kind, "committed");
    const recordRace = await race(stallOn(gamePk(gameId(40)), "META"), records.put({ ...r, record_version: 2, last_activity_at: r.last_activity_at + 1 }, 1), gamePk(gameId(40)), "META", otherToken);
    assert.equal(recordRace.outcome.kind, "definite");
    assert.deepEqual(await raw(b, gamePk(gameId(40)), "META"), recordRace.swapped);

    const fin = createDynamoFinancialStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    await own(b, gameId(41));
    assert.equal((await fin.create(financial(41))).outcome.kind, "committed");
    const finRace = await race(stallOn(gamePk(gameId(41)), "FIN"), fin.put(nextFinancial(financial(41), 5), 1), gamePk(gameId(41)), "FIN", otherToken);
    assert.notEqual(finRace.outcome.kind, "committed");
    assert.deepEqual(await raw(b, gamePk(gameId(41)), "FIN"), finRace.swapped);
    /* No token at all (a planted or migrated item): the whole body is the condition. */
    await swap(gamePk(gameId(41)), "FIN", noToken);
    const finBare = await race(stallOn(gamePk(gameId(41)), "FIN"), fin.put(nextFinancial(financial(41), 6), 1), gamePk(gameId(41)), "FIN", (item) => ({ ...item, body: S((item.body?.S ?? "").replace(`"updated_at":${financial(41).updated_at}`, `"updated_at":${financial(41).updated_at + 999}`)) }));
    assert.notEqual(finBare.outcome.kind, "committed", "an item without a token is still named exactly (by its body)");
    assert.deepEqual(await raw(b, gamePk(gameId(41)), "FIN"), finBare.swapped);

    const intents = createDynamoIntentStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING, relayQueue: QUEUE });
    await own(b, gameId(42));
    const v1 = intent(42, 1);
    assert.equal((await intents.create(v1)).kind, "created");
    const intentRace = await race(stallOn(`INTENT#${v1.intent_id}`), intents.put(nextIntent(v1, 5), 1), gamePk(gameId(42)), `INTENT#${v1.intent_id}`, otherToken);
    assert.notEqual(intentRace.outcome.kind, "committed");
    assert.deepEqual(await raw(b, gamePk(gameId(42)), `INTENT#${v1.intent_id}`), intentRace.swapped);

    const tickets = createDynamoTicketStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    await own(b, gameId(43));
    const ledger = { frozen_at: null, grants: [{ ...grant(43, 1, 1) }] };
    assert.equal(await tickets.put(gameId(43), ledger, 0), "committed");
    const ticketRace = await race(stallOn(gamePk(gameId(43)), "TICKETS"), tickets.put(gameId(43), { frozen_at: 9, grants: ledger.grants }, 1), gamePk(gameId(43)), "TICKETS", otherToken);
    assert.equal(ticketRace.outcome, "conflict");
    assert.deepEqual(await raw(b, gamePk(gameId(43)), "TICKETS"), ticketRace.swapped);

    const holds = createDynamoHoldStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    await own(b, gameId(44));
    assert.equal((await holds.create(hold(44))).outcome.kind, "committed");
    const releaseNote = { released_at: 50, note: "verified", verification: { class: "clean", entries: 1, log_hash: null }, build: "conformance" };
    const other = JSON.stringify(hold(44, "log-corrupt", 1, "a different hold, written meanwhile"));
    const holdRace = await race(stallOn(gamePk(gameId(44)), "HOLD"), holds.release(gameId(44), releaseNote), gamePk(gameId(44)), "HOLD", (item) => ({ ...otherToken(item), body: S(other) }));
    assert.equal(holdRace.outcome.kind, "definite");
    assert.deepEqual(await raw(b, gamePk(gameId(44)), "HOLD"), holdRace.swapped, "the hold that replaced the one read is never deleted");
    await swap(gamePk(gameId(44)), "HOLD", noToken);
    const bareRelease = await race(stallOn(gamePk(gameId(44)), "HOLD"), holds.release(gameId(44), { ...releaseNote, released_at: 51 }), gamePk(gameId(44)), "HOLD", (item) => ({ ...item, body: S('{"format":"gs-game-hold",') }));
    assert.equal(bareRelease.outcome.kind, "definite", "review L-8: an unreadable hold swapped in (no token) is never deleted by a release that read another");
    assert.deepEqual(await raw(b, gamePk(gameId(44)), "HOLD"), bareRelease.swapped);
    assert.equal(await holds.releasedCopies(gameId(44)), 0);
    assert.deepEqual(b.faults.unfired(), []);
  });

  test("a lost answer is recognised by the item's RECENT tokens, even after the same item was written again before the settling read", async () => {
    const b = await open("recent");
    const G = gameId(45);
    await own(b, G);
    const fin = createDynamoFinancialStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    assert.equal((await fin.create(financial(45))).outcome.kind, "committed");
    const where = names(gamePk(G), "FIN");
    const settle = gate();
    b.faults.add({ op: TX, where, nth: 1, action: { kind: "lose-answer" }, label: "v2 lands, its answer is lost" });
    b.faults.add({ op: TX, where, nth: 2, action: { kind: "fail", code: "TimeoutError" }, label: "resend 1 unsent" });
    b.faults.add({ op: TX, where, nth: 3, action: { kind: "fail", code: "TimeoutError" }, label: "resend 2 unsent" });
    b.faults.add({ op: "GetItemCommand", where, nth: 2, action: { kind: "stall", gate: settle }, label: "the settling read waits" });
    const v2 = nextFinancial(financial(45), 5);
    const pending = fin.put(v2, 1);
    await settle.reached;
    const writer = createDynamoFinancialStore({ client: admin, table: b.table, fence: b.fence, timing: TIMING });
    assert.equal((await writer.put(nextFinancial(v2, 6), 2)).kind, "committed", "v3 is written over the landed v2");
    settle.release();
    assert.deepEqual(await pending, { kind: "committed", redone: true }, "v2's token is still among the item's recent tokens");
    assert.deepEqual(b.faults.unfired(), []);
  });

  test("the resend window bounds the resends: resending stops before the token's idempotency window can close (the outcome is then uncertain)", async () => {
    const b = await open("window");
    const G = gameId(46);
    await own(b, G);
    let clock = 0;
    const timing = { windowMs: 1_000, maxResends: Number.POSITIVE_INFINITY, baseDelayMs: 100, maxDelayMs: 100, now: () => clock, sleep: async (ms: number) => void (clock += ms) };
    const holds = createDynamoHoldStore({ client: b.client, table: b.table, fence: b.fence, timing });
    const where = names(gamePk(G), "HOLD");
    for (let nth = 1; nth <= 10; nth += 1) b.faults.add({ op: TX, where, nth, action: { kind: "fail", code: "TimeoutError" }, label: `send ${nth} unsent` });
    assert.equal((await holds.create(hold(46))).outcome.kind, "uncertain");
    assert.equal(b.faults.calls.filter((call) => call.op === TX && where(call.detail)).length, 10, "sends at 0, 100, ... 900 ms: none started after the window");
    assert.deepEqual(b.faults.unfired(), []);
    assert.throws(() => createDynamoHoldStore({ client: b.client, table: b.table, fence: b.fence, timing: { windowMs: 10 * 60_000 } }), /idempotency window/, "a window that could outlive the token is refused");
  });

  test("a join-code release whose answer was lost is settled by the index (released), and one that stays unknown is reported unknown -- never 'nothing was written'", async () => {
    const b = await open("releasecode");
    const records = createDynamoRecordStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    const code = "JUNO-AAAA-AAAA";
    assert.equal(await records.claimCode(code, gameId(47)), "claimed");
    b.faults.add({ op: TX, where: names(`JOIN#${code}`), nth: 1, action: { kind: "lose-answer" }, label: "the release lands, its answer is lost" });
    b.faults.add({ op: TX, where: names(`JOIN#${code}`), nth: 2, action: { kind: "fail", code: "TimeoutError" }, label: "resend 1 unsent" });
    b.faults.add({ op: TX, where: names(`JOIN#${code}`), nth: 3, action: { kind: "fail", code: "TimeoutError" }, label: "resend 2 unsent" });
    await records.releaseCode(code, gameId(47));
    assert.equal(await records.lookupCode(code), null);
    assert.equal(await records.claimCode(code, gameId(48)), "claimed");
    for (const nth of [4, 5, 6]) b.faults.add({ op: TX, where: names(`JOIN#${code}`), nth: nth - 3, action: { kind: "fail", code: "TimeoutError" }, label: `send ${nth - 3} unsent` });
    await assert.rejects(records.releaseCode(code, gameId(48)), (error: Error) => error.name !== "StoreDefiniteError" && /unresolved/.test(error.message));
    assert.equal(await records.lookupCode(code), gameId(48), "not released, and not claimed to be");
    assert.deepEqual(b.faults.unfired(), []);
  });

  test("a hold whose answer was lost, and which an operator released before the settling read, is recognised by its released copy", async () => {
    const b = await open("holdsettle");
    const G = gameId(49);
    await own(b, G);
    const holds = createDynamoHoldStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    const where = (detail: string) => names(gamePk(G), "HOLD")(detail) && !detail.includes('"S":"HOLDREL#');
    const settle = gate();
    b.faults.add({ op: TX, where, nth: 1, action: { kind: "lose-answer" }, label: "the hold lands, its answer is lost" });
    b.faults.add({ op: TX, where, nth: 2, action: { kind: "fail", code: "TimeoutError" }, label: "resend 1 unsent" });
    b.faults.add({ op: TX, where, nth: 3, action: { kind: "fail", code: "TimeoutError" }, label: "resend 2 unsent" });
    b.faults.add({ op: "GetItemCommand", where: names(gamePk(G), "HOLD"), nth: 2, action: { kind: "stall", gate: settle }, label: "the settling read waits" });
    const pending = holds.create(hold(49));
    await settle.reached;
    const operator = createDynamoHoldStore({ client: admin, table: b.table, fence: b.fence, timing: TIMING });
    assert.equal((await operator.release(G, { released_at: 60, note: "verified", verification: { class: "clean", entries: 1, log_hash: null }, build: "conformance" })).kind, "committed");
    settle.release();
    assert.deepEqual((await pending).outcome, { kind: "committed", redone: true });
    assert.deepEqual(b.faults.unfired(), []);
  });

  test("a transaction conflict on a first attempt (contention on a shared item) is retried here with the same token, not answered definite", async () => {
    const b = await open("conflict");
    const G = gameId(50);
    await own(b, G);
    const fin = createDynamoFinancialStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    assert.equal((await fin.create(financial(50))).outcome.kind, "committed");
    const where = names(gamePk(G), "FIN");
    b.faults.add({ op: TX, where, nth: 1, action: { kind: "fail", code: "TransactionConflictException" }, label: "another transaction holds the item" });
    b.faults.add({ op: TX, where, nth: 2, action: { kind: "fail", code: "TransactionConflictException" }, label: "and again" });
    assert.deepEqual(await fin.put(nextFinancial(financial(50), 5), 1), { kind: "committed", redone: false });
    const tokens = b.faults.calls.filter((call) => call.op === TX && where(call.detail)).slice(-3).map((call) => (JSON.parse(call.detail) as { ClientRequestToken: string }).ClientRequestToken);
    assert.equal(new Set(tokens).size, 1, "one logical write, one token");
    for (const nth of [1, 2, 3, 4]) b.faults.add({ op: TX, where, nth, action: { kind: "fail", code: "TransactionConflictException" }, label: `conflict ${nth}` });
    assert.equal((await fin.put(nextFinancial(nextFinancial(financial(50), 5), 6), 2)).kind, "definite", "a conflict that persists is a definite refusal (nothing was applied)");
    assert.deepEqual(b.faults.unfired(), []);
  });

  test("two tasks racing to take one pool: exactly one gets the new epoch, the other is told it lost (never two tasks on one epoch)", async () => {
    const b = await open("poolrace");
    const faults = new FaultScript();
    const stall = gate();
    faults.add({ op: "UpdateItemCommand", nth: 1, action: { kind: "stall", gate: stall }, label: "task A pauses between its read and its update" });
    const slow = createDynamoDbClient(TARGET);
    installFaults(slow, faults);
    try {
      const a = takeOverPool(slow, b.table, POOL, "task-A", 2);
      await stall.reached;
      assert.deepEqual(await takeOverPool(admin, b.table, POOL, "task-B", 2), { kind: "taken", epoch: 2 });
      stall.release();
      assert.deepEqual(await a, { kind: "lost", by: { writer_epoch: 2, writer_task: "task-B" } });
      assert.deepEqual(await readPool(admin, b.table, POOL), { writer_epoch: 2, writer_task: "task-B" });
      assert.deepEqual(faults.unfired(), []);
    } finally {
      slow.destroy();
    }
  });

  test("a transaction conflict delivered the way TransactWriteItems delivers it (TransactionCanceled, reason TransactionConflict) is retried with the same token", async () => {
    const b = await open("cancelconflict");
    const G = gameId(51);
    await own(b, G);
    const client = createDynamoDbClient(TARGET);
    let left = 2;
    const tokens: string[] = [];
    client.middlewareStack.add(
      (next, context) => async (args) => {
        if ((context as { commandName?: string }).commandName === TX) {
          tokens.push((args as { input: { ClientRequestToken: string } }).input.ClientRequestToken);
          if (left > 0) {
            left -= 1;
            throw Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", $fault: "client", $metadata: {}, CancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }] });
          }
        }
        return next(args);
      },
      { step: "initialize", name: "l52CancelConflict" },
    );
    try {
      const fin = createDynamoFinancialStore({ client, table: b.table, fence: b.fence, timing: TIMING });
      assert.equal((await fin.create(financial(51))).outcome.kind, "committed");
      assert.equal(tokens.length, 3);
      assert.equal(new Set(tokens).size, 1, "one logical write, one token");
    } finally {
      client.destroy();
    }
  });

  test("a relay-queue item is removed by the key the intent was CREATED with, even when the store that ends the intent is configured with another queue", async () => {
    const b = await open("queuemove");
    const G = gameId(52);
    await own(b, G);
    const before = createDynamoIntentStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING, relayQueue: "juno1oldrelayer" });
    const after = createDynamoIntentStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING, relayQueue: "juno1newrelayer" });
    const a = intent(52, 1, 100);
    assert.equal((await before.create(a)).kind, "created");
    const v2 = nextIntent(a, 150);
    assert.equal((await after.put(v2, 1)).kind, "committed", "a non-terminal put carries the stored queue key forward");
    assert.equal((await after.put(confirmedIntent(v2, "chain-state", null, "10", "seen", 200), 2)).kind, "committed");
    assert.deepEqual(await before.relayQueue(), [], "the old queue's item went with the confirmation");
    assert.deepEqual(await after.relayQueue(), []);
  });

  test("index reconciliation never overwrites: a damaged entry is left exactly as found (reported), and a claim made between the scan and the write stands", async () => {
    const b = await open("reconcile");
    const records = createDynamoRecordStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    const damaged = "JUNO-BBBB-BBBB";
    await admin.send(new PutItemCommand({ TableName: b.table, Item: { pk: S(`JOIN#${damaged}`), sk: S("JOIN"), game_id: S("not a game") } }), { abortSignal: deadline() });
    const before = await raw(b, `JOIN#${damaged}`, "JOIN");
    const result = await records.reconcileIndex(new Map([[damaged, gameId(53)]]));
    assert.equal(result.outcome.kind, "definite", "damage is reported, not repaired");
    assert.deepEqual(await raw(b, `JOIN#${damaged}`, "JOIN"), before, "left exactly as found");
    const raced = "JUNO-CCCC-CCCC";
    const stall = gate();
    b.faults.add({ op: TX, where: names(`JOIN#${raced}`), action: { kind: "stall", gate: stall }, label: "the reconciliation's write waits after its scan" });
    const pending = records.reconcileIndex(new Map([[raced, gameId(54)]]));
    await stall.reached;
    const other = createDynamoRecordStore({ client: admin, table: b.table, fence: b.fence, timing: TIMING });
    assert.equal(await other.claimCode(raced, gameId(55)), "claimed");
    stall.release();
    assert.equal((await pending).outcome.kind, "definite");
    assert.equal(await records.lookupCode(raced), gameId(55), "the claim made meanwhile stands");
    assert.deepEqual(b.faults.unfired(), []);
  });

  test("claimGame and releaseGame settle a lost answer by the HEAD (claimed; released), and never answer an unknown outcome as 'absent' or 'not mine'", async () => {
    const b = await open("claimunknown");
    const G = gameId(56);
    await own(b, G);
    const faults = new FaultScript();
    const client = createDynamoDbClient(TARGET);
    installFaults(client, faults);
    try {
      faults.add({ op: TX, nth: 1, action: { kind: "lose-answer" }, label: "the claim lands, its answer is lost" });
      faults.add({ op: TX, nth: 2, action: { kind: "fail", code: "TimeoutError" }, label: "resend 1 unsent" });
      faults.add({ op: TX, nth: 3, action: { kind: "fail", code: "TimeoutError" }, label: "resend 2 unsent" });
      assert.deepEqual(await takeOverPool(admin, b.table, POOL, "task-2", 2), { kind: "taken", epoch: 2 });
      const claimed = await claimGame(client, b.table, G, { pool: POOL, epoch: 2, task: "task-2" }, TIMING);
      assert.equal(claimed.kind, "claimed");
      for (const nth of [1, 2, 3]) faults.add({ op: TX, nth, action: { kind: "fail", code: "TimeoutError" }, label: `claim send ${nth} unsent` });
      await assert.rejects(claimGame(client, b.table, gameId(57), { pool: POOL, epoch: 2, task: "task-2" }, TIMING), /unknown/, "an unknown claim of an absent game is never answered 'absent'");
      faults.add({ op: "UpdateItemCommand", nth: 1, action: { kind: "lose-answer" }, label: "the release lands, its answer is lost" });
      assert.equal(await releaseGame(client, b.table, G, { pool: POOL, epoch: 2 }), true, "settled by the HEAD: released");
      assert.equal((await readHead(admin, b.table, G))?.owner_pool, "#none");
      assert.deepEqual(faults.unfired(), []);
    } finally {
      client.destroy();
    }
  });

  test("a join-code release names the exact CLAIM it read: held back until the same game has claimed the code again, it removes nothing", async () => {
    const b = await open("releaseclaim");
    const records = createDynamoRecordStore({ client: b.client, table: b.table, fence: b.fence, timing: TIMING });
    const code = "JUNO-DDDD-DDDD";
    assert.equal(await records.claimCode(code, gameId(58)), "claimed");
    const stall = gate();
    b.faults.add({ op: TX, where: names(`JOIN#${code}`), action: { kind: "stall", gate: stall }, label: "the release waits after reading the claim" });
    const pending = records.releaseCode(code, gameId(58));
    await stall.reached;
    const again = createDynamoRecordStore({ client: admin, table: b.table, fence: b.fence, timing: TIMING });
    assert.equal(await again.claimCode(code, gameId(58)), "claimed", "the same game claims the code again (a new claim)");
    const reclaimed = await raw(b, `JOIN#${code}`, "JOIN");
    stall.release();
    await pending;
    assert.deepEqual(await raw(b, `JOIN#${code}`, "JOIN"), reclaimed, "the late release did not remove the newer claim");
    assert.deepEqual(b.faults.unfired(), []);
  });
});
