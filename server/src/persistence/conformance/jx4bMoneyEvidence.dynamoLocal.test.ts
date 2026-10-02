// server/src/persistence/conformance/jx4bMoneyEvidence.dynamoLocal.test.ts
//
// ==================================================================
//  JX-4B: `gamesDoctor aws money` ON DYNAMODB LOCAL -- THE EVIDENCE READER OVER ITEMS THE PRODUCTION WRITERS WROTE
// ==================================================================
//
// Runs ONLY against a DynamoDB Local named by GS_DYNAMODB_LOCAL_ENDPOINT (`npm run test:dynamodb-local`); without one it
// FAILS with instructions. Every table is this run's own and is dropped at the end.
//
// A real money world (`escrow/jx4bSupport.ts`) runs a Start that needed a second attempt; its durable state is then
// written into DynamoDB by the PRODUCTION writers, in production order -- the financial store's create, the ticket
// store's put, the intent store's create (with its RELAYQ# item in the same transaction) and its terminal put (which
// removes it), the signing ledger's relayer takeover and `recordAttempt` (TXID# / ATTEMPT# / ATTI# in one transaction).
// The CLI then reads them over the wire. Pinned: the reader parses exactly what the writers wrote (clean evidence,
// JOURNAL MATCH, every attempt); `--tx-bytes` returns the bytes the intent store holds; and every table is byte-identical
// before and after the tool ran (it wrote nothing).

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { PutItemCommand, ScanCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createDynamoDbClient, deadline, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../../aws/awsClients";
import { createDynamoFinancialStore } from "../../aws/game/dynamoFinancialStore";
import { createDynamoIntentStore } from "../../aws/game/dynamoIntentStore";
import { createDynamoTicketStore } from "../../aws/game/dynamoTicketStore";
import { gamePk, headKey, key, META_SK, poolKey } from "../../aws/game/gameTable";
import type { ResendTiming } from "../../aws/game/transact";
import { familyItem, principalItem, profileItem } from "../../aws/identity/identityItems";
import { LEDGER_KEYS, openDynamoSigningLedger } from "../../aws/ledger/dynamoSigningLedger";
import { EXIT, runAwsOperator } from "../../aws/operator/operatorMain";
import { RELAYER_ADDRESS } from "../../escrow/escrow3bSupport";
import { moneyEvidenceWorld } from "../../escrow/jx4bSupport";
import { quietConsole } from "../../rooms/testSupport";
import type { MoneyEvidenceView, TxBytesExport } from "../../tools/moneyEvidence";
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
const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number): AttributeValue => ({ N: String(value) });
const TIMING: Partial<ResendTiming> = { maxResends: 2, windowMs: 60_000, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined };
const FENCE = { pool: "pool-a", epoch: 1 };

quietConsole();

after(async () => {
  await tables.dropAll();
  assert.deepEqual(tables.live, [], "every table this run made was dropped");
  admin.destroy();
});

const put = (table: string, item: Record<string, AttributeValue>) => admin.send(new PutItemCommand({ TableName: table, Item: item }), { abortSignal: deadline() });

/** Every item of a table, in key order (the before / after comparison). */
async function dump(table: string): Promise<string> {
  const items: Array<Record<string, AttributeValue>> = [];
  let start: Record<string, AttributeValue> | undefined;
  do {
    const page = await admin.send(new ScanCommand({ TableName: table, ConsistentRead: true, ExclusiveStartKey: start }), { abortSignal: deadline() });
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  const canonical = (item: Record<string, AttributeValue>) => JSON.stringify(Object.keys(item).sort().map((name) => [name, item[name]]));
  return items.map(canonical).sort().join("\n");
}

describe("JX-4B money evidence on DynamoDB Local", () => {
  test("a Start with two attempts, written by the production writers: the reader reads exactly what they wrote -- clean, JOURNAL MATCH, every attempt, the exact bytes -- and writes nothing", async () => {
    await requireLocal(admin);
    const e = await moneyEvidenceWorld("retry-started");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jx4b-"));
    try {
      const g = e.gameId;
      const game = await tables.create("jx4b-game");
      const identity = await tables.create("jx4b-identity");
      const ledgerTable = await tables.create("jx4b-ledger");
      const stored = await e.world.intents.listGame(g);
      const client = createDynamoDbClient(TARGET);
      try {
        /* The game table: the pool and the game's HEAD (the writers' fence), then the stores' own writes. */
        await put(game, { ...poolKey(FENCE.pool), writer_epoch: N(FENCE.epoch), writer_task: S("task-jx4b") });
        await put(game, { ...headKey(g), owner_pool: S(FENCE.pool), pool_epoch: N(FENCE.epoch), log_next_index: N(0), log_bytes: N(0) });
        const base = { client, table: game, fence: FENCE, timing: TIMING };
        const fin = (await e.world.financial.load(g))!;
        assert.equal((await createDynamoFinancialStore(base).create({ ...fin, record_version: 1 })).outcome.kind, "committed");
        const record = e.world.server.rooms.moneyPort.recordOf(g)!;
        await put(game, { ...key(gamePk(g), META_SK), body: S(JSON.stringify(record)), record_version: N(record.record_version) });
        const { document } = await e.world.ticketStore.load(g);
        assert.equal(await createDynamoTicketStore(base).put(g, document, 0), "committed");
        const intents = createDynamoIntentStore({ ...base, relayQueue: RELAYER_ADDRESS });
        for (const intent of stored) {
          /* As the service makes it (pending, no attempt; its queue item in the same transaction) ... */
          const fresh = { ...intent, record_version: 1, status: "pending" as const, attempts: [], confirmation: null, superseded: null, hold: null, retry: { failures: 0, next_at: intent.created_at } };
          assert.equal((await intents.create(fresh)).kind, "created");
          /* ... then its stored state as the relayer left it (a terminal write removes the queue item). */
          assert.equal((await intents.put({ ...intent, record_version: 2 }, 1)).kind, "committed", intent.op.kind);
        }
        /* The identity items the grants name. */
        const snapshot = e.world.identityStore.snapshot();
        for (const item of [...snapshot.principals.map(principalItem), ...snapshot.profiles.map(profileItem), ...snapshot.families.map(familyItem)]) await put(identity, item);
        /* The ledger: APPGEN, the relayer's takeover, then every journalled attempt through `recordAttempt`. */
        await put(ledgerTable, { ...LEDGER_KEYS.appgen(), schema: N(1), current_generation: N(1) });
        const ledger = await openDynamoSigningLedger(client, { table: ledgerTable, generation: 1, relayer: { address: RELAYER_ADDRESS }, sleep: async () => undefined, resends: 2 });
        await ledger.takeOverRelayer();
        for (const entry of await e.world.journal.allAttempts()) {
          await ledger.recordAttempt({ intent_id: entry.intent_id, tx_id: entry.tx_id, account: entry.account, account_sequence: entry.sequence, ...(entry.expires_after_height !== undefined ? { expires_after_height: entry.expires_after_height } : {}) });
        }
      } finally {
        client.destroy();
      }
      const doc = path.join(dir, "runtime.json");
      await fs.writeFile(doc, JSON.stringify({ format: "18COSMOS/AWS-RUNTIME/v1", environment: "local", region: "us-east-1", pool: FENCE.pool, generation: 1, game_table: game, identity_table: identity, ledger_table_arn: `arn:aws:dynamodb:us-east-1:000000000000:table/${ledgerTable}`, escrow: null }));
      const before = [await dump(game), await dump(identity), await dump(ledgerTable)];
      const run = async (extra: string[]) => {
        const out: string[] = [];
        const err: string[] = [];
        const code = await runAwsOperator(["money", g, "--local-document", doc, "--relayer", RELAYER_ADDRESS, ...extra], { [DYNAMODB_LOCAL_ENV]: process.env[DYNAMODB_LOCAL_ENV] }, { out: (line) => out.push(line), err: (line) => err.push(line) }, { now: () => e.world.clock.now });
        return { code, out, err };
      };
      const answered = await run(["--json"]);
      const v = JSON.parse(answered.out.join("\n")) as MoneyEvidenceView;
      assert.equal(answered.code, EXIT.ok, `${answered.err.join("\n")}\n${JSON.stringify(v.checks, null, 1)}`);
      assert.equal(v.summary.clean, true);
      assert.equal(v.verdicts.journal, "JOURNAL MATCH");
      const start = v.intents.items.find((intent) => intent.op === "start")!;
      const original = stored.find((intent) => intent.op.kind === "start")!;
      assert.ok(original.attempts.length >= 2);
      assert.deepEqual(start.attempts.map((a) => [a.n, a.tx_hash, a.phase, a.journal.atti, a.journal.txid]), original.attempts.map((a) => [a.n, a.tx_hash, a.phase, "match", "match"]));
      assert.ok(v.intents.items.every((intent) => intent.relay.verdict === "ok"), "the queue holds exactly the non-terminal intents the writers left");
      assert.equal(v.tickets.grants?.identity.read, true);
      /* --tx-bytes: the bytes the intent store holds. */
      const included = original.attempts.find((a) => a.phase === "included-success")!;
      const exported = await run(["--json", "--tx-bytes", original.intent_id, "--tx-hash", included.tx_hash]);
      assert.equal(exported.code, EXIT.ok, exported.err.join("\n"));
      assert.equal((JSON.parse(exported.out.join("\n")) as TxBytesExport).tx_base64, included.tx_bytes);
      /* The text form, too; then nothing was written anywhere. */
      const text = await run([]);
      assert.equal(text.code, EXIT.ok);
      assert.match(text.out.join("\n"), /^JOURNAL MATCH$/m);
      assert.deepEqual([await dump(game), await dump(identity), await dump(ledgerTable)], before, "every table is byte-identical: the reader wrote nothing");
    } finally {
      await e.world.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
