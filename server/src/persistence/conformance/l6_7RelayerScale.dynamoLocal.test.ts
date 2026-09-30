// server/src/persistence/conformance/l6_7RelayerScale.dynamoLocal.test.ts
//
// ==================================================================
//  LIVE-6 L6-7: BOUNDED RELAYER / ESCROW STARTUP WORK -- ON DYNAMODB LOCAL (the game table and the signing ledger)
// ==================================================================
//
// Runs ONLY against a DynamoDB Local named by GS_DYNAMODB_LOCAL_ENDPOINT (`npm run test:dynamodb-local`), like the rest
// of LIVE-5's DynamoDB suites; without one it FAILS with instructions. Every request is counted at the client (command,
// partition, items the service scanned), so "bounded" is measured on the wire, not inferred.
//
//   §1 RELAYQ#: the relayer's startup reads the queue and each queued intent by its key -- the same requests whether the
//      table holds 30 or 150 historic games; every page; strict (a malformed entry refuses the load); a queued intent
//      that is gone is a reported disagreement, not work; the entry leaves only with the terminal write.
//   §2 the ledger's bounded range (`attemptsFrom`): only the attempts at the chain's sequence or above are read (the
//      service scans nothing below), every page; damage below the range is never read, damage in it refuses the answer;
//      the relayer's startup guard over it -- spent history guards nothing, a forgotten live attempt still blocks.
//   §3 the open-money-game index (FINKEYS -> FINIDX#): every open money game (held ones too), no closed or cancelled one;
//      strict; the escrow service's load reads no closed game's record and no `LIST#fin`.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { DeleteItemCommand, GetItemCommand, PutItemCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createDynamoDbClient, deadline, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../../aws/awsClients";
import { createDynamoFinancialStore, OpenMoneyIndexDamageError } from "../../aws/game/dynamoFinancialStore";
import { createDynamoIntentStore } from "../../aws/game/dynamoIntentStore";
import { FINKEYS_KEY, headKey, poolKey, relayQueueKey } from "../../aws/game/gameTable";
import type { ResendTiming } from "../../aws/game/transact";
import { LEDGER_KEYS, LedgerUnreadableError, openDynamoSigningLedger, type DynamoSigningLedger } from "../../aws/ledger/dynamoSigningLedger";
import { junoInstanceOf, newChainIntent, RelayQueueDamageError, supersededIntent, type ChainIntentRecord } from "../../escrow/chainIntents";
import { createMemoryFinancialGameStore } from "../../escrow/financialGameStore";
import { RELAYER_EXECUTE } from "../../escrow/juno/junoContract";
import { newFinancialRecord, transitionFinancial, type FinancialGameRecord } from "../../escrow/moneyLifecycle";
import { currentMoneyContinuation } from "../../escrow/moneyContinuation";
import { CHAIN_ID, CONTRACT, fundedGame, GAME_A, GAME_B, makeWorld, PIN, RELAYER_ADDRESS, T0, VARIANTS, type World } from "../../escrow/escrow3bSupport";
import { ALICE, BOB, quietConsole } from "../../rooms/testSupport";
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
const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number): AttributeValue => ({ N: String(value) });
const TIMING: Partial<ResendTiming> = { maxResends: 2, windowMs: 60_000, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined };
const FENCE = { pool: "pool-a", epoch: 1 };

quietConsole();

after(async () => {
  for (const client of clients) client.destroy();
  await tables.dropAll();
  assert.deepEqual(tables.live, [], "every table this run made was dropped");
  admin.destroy();
});

/** Every command this client sends, by name; every Query's partition; the items the service scanned for them. */
interface Wire {
  readonly commands: Map<string, number>;
  readonly queries: string[];
  scanned: number;
  reset(): void;
  snapshot(): { readonly commands: Record<string, number>; readonly queries: readonly string[]; readonly scanned: number };
}

async function countedClient(): Promise<{ readonly client: DynamoDBClient; readonly wire: Wire }> {
  const client = createDynamoDbClient(TARGET);
  await requireLocal(client);
  clients.push(client);
  const wire: Wire = {
    commands: new Map(),
    queries: [],
    scanned: 0,
    reset() {
      this.commands.clear();
      this.queries.length = 0;
      this.scanned = 0;
    },
    snapshot() {
      return { commands: Object.fromEntries([...this.commands].sort()), queries: [...this.queries].sort(), scanned: this.scanned };
    },
  };
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const op = (context as { commandName?: string }).commandName ?? "unknown";
      wire.commands.set(op, (wire.commands.get(op) ?? 0) + 1);
      const input = (args as { input?: { ExpressionAttributeValues?: Record<string, AttributeValue> } }).input;
      if (op === "QueryCommand") wire.queries.push(input?.ExpressionAttributeValues?.[":pk"]?.S ?? "?");
      const result = await next(args);
      if (op === "QueryCommand") wire.scanned += Number((result.output as { ScannedCount?: number }).ScannedCount ?? 0);
      return result;
    },
    { step: "initialize", name: `gsL67Counter-${newRunId()}` },
  );
  return { client, wire };
}

const put = (table: string, item: Record<string, AttributeValue>) => admin.send(new PutItemCommand({ TableName: table, Item: item }), { abortSignal: deadline() });

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function gameIdOf(n: number): string {
  let digits = "";
  let rest = n;
  for (let i = 0; i < 25; i += 1) {
    digits = ALPHABET[rest % 32] + digits;
    rest = Math.floor(rest / 32);
  }
  return `g_${digits}r`;
}

function syntheticIntent(gameId: string, chainGameId: number, now: number = T0): ChainIntentRecord {
  const id = String(chainGameId);
  return newChainIntent({
    game_id: gameId,
    instance: junoInstanceOf(CHAIN_ID, CONTRACT, id),
    key: { op: "finalize", seq: "3" },
    subject: { kind: "digest", digests: [{ codec: "18JUNO/v1", purpose: "settle", hex: "77".repeat(32) }] },
    op: { kind: "finalize", chain_game_id: id, seq: "3" },
    msg_json: RELAYER_EXECUTE.finalize(id),
    now,
  });
}

const headOf = (gameId: string) => ({ ...headKey(gameId), owner_pool: S(FENCE.pool), pool_epoch: N(FENCE.epoch), log_next_index: N(0), log_bytes: N(0) });

async function gameTable(label: string): Promise<string> {
  const table = await tables.create(label);
  await put(table, { ...poolKey(FENCE.pool), writer_epoch: N(FENCE.epoch) });
  return table;
}

async function ledgerTable(label: string): Promise<string> {
  const table = await tables.create(label);
  await put(table, { ...LEDGER_KEYS.appgen(), schema: N(1), current_generation: N(1) });
  return table;
}

/** A ledger instance holding the relayer fence (it may record attempts), over a counted client. */
async function heldLedger(table: string, pageSize?: number): Promise<{ readonly ledger: DynamoSigningLedger; readonly wire: Wire }> {
  const { client, wire } = await countedClient();
  const ledger = await openDynamoSigningLedger(client, { table, generation: 1, relayer: { address: RELAYER_ADDRESS }, sleep: async () => undefined, resends: 2, ...(pageSize !== undefined ? { pageSize } : {}) });
  await ledger.takeOverRelayer();
  return { ledger, wire };
}

const TX = (n: number) => n.toString(16).toUpperCase().padStart(64, "0");

/* ==================================================================
    §1 RELAYQ#
   ================================================================== */

describe("§1 the relay queue on DynamoDB", () => {
  /** A game table with `historic` finished games (an intent each, superseded -- out of the queue) and `queued` open ones. */
  async function seeded(label: string, historic: number, queued: number, pageSize = 2) {
    const table = await gameTable(label);
    const { client, wire } = await countedClient();
    const store = createDynamoIntentStore({ client, table, fence: FENCE, relayQueue: RELAYER_ADDRESS, timing: TIMING, pageSize });
    for (let n = 0; n < historic; n += 1) {
      const gameId = gameIdOf(10_000 + n);
      await put(table, headOf(gameId));
      const intent = syntheticIntent(gameId, 50_000 + n);
      assert.equal((await store.create(intent)).kind, "created");
      assert.equal((await store.put(supersededIntent(intent, "history", T0 + 1), 1)).kind, "committed");
    }
    const open: ChainIntentRecord[] = [];
    for (let n = 0; n < queued; n += 1) {
      const gameId = gameIdOf(90_000 + n);
      await put(table, headOf(gameId));
      const intent = syntheticIntent(gameId, 90_000 + n, T0 + n);
      assert.equal((await store.create(intent)).kind, "created");
      open.push(intent);
    }
    return { table, client, wire, store, open };
  }

  test("the relayer's startup work grows with the queue, NOT with the table's history: 30 or 150 finished games, the same requests -- the queue (every page) and each queued intent by its key; never LIST#intent", async () => {
    const runs: Array<ReturnType<Wire["snapshot"]> & { readonly ledger: ReturnType<Wire["snapshot"]> }> = [];
    for (const historic of [30, 150]) {
      const { store, wire, open } = await seeded(`l67-q-${historic}`, historic, 3);
      const ledgerTableName = await ledgerTable(`l67-ql-${historic}`);
      const { ledger, wire: ledgerWire } = await heldLedger(ledgerTableName);
      /* History in the ledger too: attempts at sequences the chain has spent. */
      for (let n = 0; n < historic; n += 1) await ledger.recordAttempt({ intent_id: "ee".repeat(32), tx_id: TX(1 + n), account: RELAYER_ADDRESS, account_sequence: String(n), expires_after_height: String(n + 10) });
      const world = makeWorld({ intents: store, journal: ledger });
      (world.chain.accounts.get(RELAYER_ADDRESS) as { sequence: bigint }).sequence = BigInt(historic);
      wire.reset();
      ledgerWire.reset();
      await world.relayer.load();
      const status = world.relayer.status();
      assert.equal(status.discovery, "queue");
      assert.equal(status.open + status.skipped + status.undecided, 3, "all three queued intents are the relayer's to decide");
      assert.equal(status.forgotten_guard, null, "spent history guards nothing");
      assert.deepEqual(
        (await store.relayQueue()).map((entry) => entry.intent_id),
        open.map((intent) => intent.intent_id),
        "oldest first",
      );
      runs.push({ ...wire.snapshot(), ledger: ledgerWire.snapshot() });
    }
    for (const run of runs) {
      assert.ok(!run.queries.some((pk) => pk.startsWith("LIST#")), `no listing: ${run.queries.join(",")}`);
      assert.equal(run.ledger.scanned, 0, "the ledger's startup read scanned nothing below the chain's sequence");
    }
    assert.deepEqual(runs[0].commands, runs[1].commands, "the same requests whatever the history");
    assert.deepEqual(runs[0].queries, runs[1].queries, "the same partitions read");
    assert.equal(runs[0].ledger.scanned, runs[1].ledger.scanned);
    assert.ok(runs[0].queries.filter((pk) => pk === `RELAYQ#${RELAYER_ADDRESS}`).length >= 2, "the queue read page by page (page size 2, three entries)");
  });

  test("pagination never truncates: seven queued intents, page size 2 -- all seven, in queue order", async () => {
    const { store, open } = await seeded("l67-pages", 0, 7, 2);
    const entries = await store.relayQueue();
    assert.deepEqual(
      entries.map((entry) => entry.intent_id),
      open.map((intent) => intent.intent_id),
    );
    const world = makeWorld({ intents: store });
    await world.relayer.load();
    const status = world.relayer.status();
    assert.equal(status.open + status.skipped + status.undecided, 7);
  });

  test("one malformed queue item refuses the whole queue -- and so the relayer's load (fail-closed)", async () => {
    const { table, store, open } = await seeded("l67-damage", 0, 2);
    const first = open[0];
    const queued = relayQueueKey(RELAYER_ADDRESS, first.created_at, first.game_id, first.intent_id);
    const damages: Array<Record<string, AttributeValue>> = [
      { ...queued, game_id: S(first.game_id), intent_id: S(first.intent_id), created_at: N(first.created_at), extra: S("x") },
      { ...queued, game_id: S(first.game_id), intent_id: S(first.intent_id), created_at: N(first.created_at + 1) },
      { ...queued, game_id: S(GAME_B), intent_id: S(first.intent_id), created_at: N(first.created_at) },
      { pk: queued.pk, sk: S(`not-a-key#${first.intent_id}`), game_id: S(first.game_id), intent_id: S(first.intent_id), created_at: N(first.created_at) },
    ];
    for (const damaged of damages) {
      await put(table, damaged);
      await assert.rejects(store.relayQueue(), RelayQueueDamageError);
      const world = makeWorld({ intents: store });
      await assert.rejects(world.relayer.load(), RelayQueueDamageError);
      /* Restore the item as the create wrote it (and drop a stray key). */
      await put(table, { ...queued, game_id: S(first.game_id), intent_id: S(first.intent_id), created_at: N(first.created_at) });
      if (damaged.sk.S !== queued.sk.S) await admin.send(new DeleteItemCommand({ TableName: table, Key: { pk: damaged.pk, sk: damaged.sk } }), { abortSignal: deadline() });
      assert.equal((await store.relayQueue()).length, 2);
    }
  });

  test("a queue item naming an intent the table does not have is a DISAGREEMENT: reported and paged, never work; the load succeeds", async () => {
    const { table, store } = await seeded("l67-missing", 0, 1);
    const stray = relayQueueKey(RELAYER_ADDRESS, T0, GAME_A, "ab".repeat(32));
    await put(table, { ...stray, game_id: S(GAME_A), intent_id: S("ab".repeat(32)), created_at: N(T0) });
    const world = makeWorld({ intents: store });
    await world.relayer.load();
    const status = world.relayer.status();
    assert.equal(status.queue_mismatch, 1);
    assert.equal(status.open + status.skipped + status.undecided, 1, "only the real intent");
    assert.equal(world.ops.lines.filter((line) => line.event === "chain.relay-queue-mismatch" && line.kind === "missing").length, 1);
    assert.equal(world.ops.lines.filter((line) => line.event === "chain.relayer-page" && line.condition === "relay-queue-mismatch").length, 1);
  });

  test("the entry leaves ONLY with the terminal write: held keeps it, superseded removes it", async () => {
    const { store, open } = await seeded("l67-terminal", 0, 2);
    const [held, done] = open;
    assert.equal((await store.put({ ...held, status: "held", hold: { code: "chain-intent-held", detail: "test", at: T0 }, record_version: 2, updated_at: T0 }, 1)).kind, "committed");
    assert.equal((await store.put(supersededIntent(done, "moot", T0 + 1), 1)).kind, "committed");
    assert.deepEqual((await store.relayQueue()).map((entry) => entry.intent_id), [held.intent_id]);
    const world = makeWorld({ intents: store });
    await world.relayer.load();
    const status = world.relayer.status();
    assert.equal(status.open + status.skipped + status.undecided, 1, "the superseded intent is not work");
    assert.equal(status.queue_mismatch, 0);
  });
});

/* ==================================================================
    §2 THE LEDGER'S BOUNDED RANGE
   ================================================================== */

describe("§2 attemptsFrom: the attempts that may still be live, and nothing below them", () => {
  test("sixty attempts, page size 4: from sequence 50 the answer is exactly 50..59 -- complete over every page, and the service scanned nothing below", async () => {
    const table = await ledgerTable("l67-range");
    const { ledger, wire } = await heldLedger(table, 4);
    for (let n = 0; n < 60; n += 1) await ledger.recordAttempt({ intent_id: "aa".repeat(32), tx_id: TX(100 + n), account: RELAYER_ADDRESS, account_sequence: String(n), ...(n % 2 === 0 ? { expires_after_height: String(1000 + n) } : {}) });
    wire.reset();
    const answer = await ledger.attemptsFrom(RELAYER_ADDRESS, "50");
    assert.deepEqual(
      answer.map((entry) => Number(entry.sequence)),
      Array.from({ length: 10 }, (_, i) => 50 + i),
    );
    assert.equal(wire.scanned, 10, "only the range was read");
    assert.ok((wire.commands.get("QueryCommand") ?? 0) >= 3, "and it was paged (4 per page)");
    assert.equal(answer.filter((entry) => entry.expires_after_height !== undefined).length, 5);
    assert.deepEqual(await ledger.attemptsFrom(RELAYER_ADDRESS, "60"), []);
    assert.equal((await ledger.attemptsFrom(RELAYER_ADDRESS, "0")).length, 60, "from 0: every attempt (nothing is ever deleted)");
    await assert.rejects(ledger.attemptsFrom(RELAYER_ADDRESS, "07"), /canonical/);
  });

  test("damage BELOW the range is never read (history cannot stop current work); damage IN the range refuses the whole answer", async () => {
    const table = await ledgerTable("l67-damage");
    const { ledger } = await heldLedger(table);
    for (let n = 0; n < 12; n += 1) await ledger.recordAttempt({ intent_id: "bb".repeat(32), tx_id: TX(200 + n), account: RELAYER_ADDRESS, account_sequence: String(n), expires_after_height: String(500 + n) });
    const below = LEDGER_KEYS.attempt(RELAYER_ADDRESS, "3", TX(203));
    await put(table, { ...below, schema: N(1), kind: S("attempt") }); // damaged: most attributes gone
    await assert.rejects(ledger.allAttempts(RELAYER_ADDRESS), LedgerUnreadableError, "the damage is real");
    assert.equal((await ledger.attemptsFrom(RELAYER_ADDRESS, "10")).length, 2, "and below the range it is never read");
    const inRange = LEDGER_KEYS.attempt(RELAYER_ADDRESS, "11", TX(211));
    await put(table, { ...inRange, schema: N(2) }); // a newer build's item in the range
    await assert.rejects(ledger.attemptsFrom(RELAYER_ADDRESS, "10"), (error: unknown) => error instanceof LedgerUnreadableError && error.format === "newer");
  });

  test("the relayer end to end on the DynamoDB ledger: 150 spent attempts guard nothing (the Start lands at the chain's sequence); a forgotten attempt that may still land blocks until the chain spends it", async () => {
    const table = await ledgerTable("l67-e2e");
    const { ledger, wire } = await heldLedger(table);
    for (let n = 0; n < 150; n += 1) await ledger.recordAttempt({ intent_id: "cc".repeat(32), tx_id: TX(300 + n), account: RELAYER_ADDRESS, account_sequence: String(n), expires_after_height: String(n + 20) });
    const game = await gameTable("l67-e2e-game");
    const { client } = await countedClient();
    const intents = createDynamoIntentStore({ client, table: game, fence: FENCE, relayQueue: RELAYER_ADDRESS, timing: TIMING });
    const financial = createMemoryFinancialGameStore();
    const world = makeWorld({ intents, journal: ledger, financial });
    await put(game, headOf(GAME_A));
    await put(game, headOf(GAME_B));
    const account = world.chain.accounts.get(RELAYER_ADDRESS) as { sequence: bigint };
    account.sequence = BigInt(150);
    /* Game A: a pending Start; a restart loads it from the queue with the bounded guard. */
    assert.ok((await world.service.createMoneyGame(GAME_A)).ok);
    const chainA = await fundedGame(world, GAME_A);
    assert.ok((await world.service.bindChainGame(GAME_A, chainA, VARIANTS)).ok);
    assert.ok((await world.service.requestStart(GAME_A, [{ player_id: ALICE }, { player_id: BOB }])).ok);
    wire.reset();
    await world.restart();
    assert.equal(world.relayer.status().forgotten_guard, null);
    assert.equal(wire.scanned, 0, "the ledger scanned nothing of the 150 spent attempts");
    await world.drive(async () => (await world.financial.load(GAME_A))?.chain.started !== null);
    const startA = (await intents.listGame(GAME_A)).find((intent) => intent.op.kind === "start") as ChainIntentRecord;
    assert.equal(startA.attempts[0].sequence, "150");
    /* A forgotten attempt at the chain's current sequence, not expired: game B's Start waits for the chain. */
    const now = account.sequence;
    await ledger.recordAttempt({ intent_id: "dd".repeat(32), tx_id: TX(9_999), account: RELAYER_ADDRESS, account_sequence: now.toString(), expires_after_height: String(world.chain.height + 100) });
    assert.ok((await world.service.createMoneyGame(GAME_B)).ok);
    const chainB = await fundedGame(world, GAME_B);
    assert.ok((await world.service.bindChainGame(GAME_B, chainB, VARIANTS)).ok);
    assert.ok((await world.service.requestStart(GAME_B, [{ player_id: ALICE }, { player_id: BOB }])).ok);
    await world.restart();
    assert.equal(world.relayer.status().forgotten_guard?.attempts, 1, "the one attempt that may still land");
    await world.relayer.pass();
    const startB = async () => (await intents.listGame(GAME_B)).find((intent) => intent.op.kind === "start") as ChainIntentRecord;
    assert.equal((await startB()).attempts.length, 0, "nothing signed over it");
    account.sequence = now + BigInt(1);
    await world.drive(async () => (await world.financial.load(GAME_B))?.chain.started !== null);
    assert.equal((await startB()).attempts[0].sequence, (now + BigInt(1)).toString());
  });
});

/* ==================================================================
    §3 THE OPEN-MONEY-GAME INDEX
   ================================================================== */

describe("§3 FINKEYS -> FINIDX#: every open money game, and no closed one", () => {
  async function money(label: string, total: number, pageSize = 3) {
    const table = await gameTable(label);
    const { client, wire } = await countedClient();
    const store = createDynamoFinancialStore({ client, table, fence: FENCE, timing: TIMING, pageSize });
    const ids = Array.from({ length: total }, (_, n) => gameIdOf(40_000 + n));
    for (const gameId of ids) assert.equal((await store.create(newFinancialRecord(gameId, currentMoneyContinuation(), T0, PIN))).outcome.kind, "committed");
    const move = async (gameId: string, event: Parameters<typeof transitionFinancial>[1]) => {
      const current = (await store.load(gameId)) as FinancialGameRecord;
      const moved = transitionFinancial(current, event);
      assert.equal(moved.kind, "moved");
      assert.equal((await store.put((moved as { next: FinancialGameRecord }).next, current.record_version)).kind, "committed");
    };
    return { table, store, wire, ids, move };
  }

  test("30 money games, 20 cancelled and one held: the index answers the 10 open ones (the held one included) over every page; LIST#fin still lists all 30", async () => {
    const { store, ids, move } = await money("l67-fin", 30);
    for (const gameId of ids.slice(0, 20)) await move(gameId, { kind: "cancel-before-deal", at: T0 + 1 });
    await move(ids[25], { kind: "hold", at: T0 + 2, code: "chain-intent-held", detail: "test" });
    assert.deepEqual(await store.openMoneyGameIds(), ids.slice(20).sort());
    assert.equal((await store.list()).length, 30);
  });

  test("strict: a FINIDX# item or a FINKEYS set that is not what the writes make refuses the whole discovery", async () => {
    const { table, store } = await money("l67-fin-damage", 2);
    const identity = ((await admin.send(new GetItemCommand({ TableName: table, Key: FINKEYS_KEY, ConsistentRead: true }), { abortSignal: deadline() })).Item?.keys?.SS ?? [])[0];
    assert.ok(identity !== undefined);
    await put(table, { pk: S(`FINIDX#${identity}`), sk: S("GAME#nonsense"), game_id: S("nonsense") });
    await assert.rejects(store.openMoneyGameIds(), OpenMoneyIndexDamageError);
    await admin.send(new DeleteItemCommand({ TableName: table, Key: { pk: S(`FINIDX#${identity}`), sk: S("GAME#nonsense") } }), { abortSignal: deadline() });
    assert.equal((await store.openMoneyGameIds()).length, 2);
    await put(table, { ...FINKEYS_KEY, keys: { SS: [identity, "not-a-key"] } });
    await assert.rejects(store.openMoneyGameIds(), OpenMoneyIndexDamageError);
  });

  test("the escrow service's load over the index: no closed game's record is read, no LIST#fin; every open game is visited", async () => {
    const { store, wire, ids, move } = await money("l67-fin-load", 12);
    for (const gameId of ids.slice(0, 10)) await move(gameId, { kind: "cancel-before-deal", at: T0 + 1 });
    const reads: string[] = [];
    const load = store.load.bind(store);
    const counted = Object.assign(Object.create(store) as typeof store, {
      load: async (gameId: string) => {
        reads.push(gameId);
        return load(gameId);
      },
    });
    const world: World = makeWorld({ financial: counted, openGames: () => store.openMoneyGameIds() });
    wire.reset();
    reads.length = 0;
    const loaded = await world.service.load();
    await world.service.idle();
    assert.equal(loaded.games, 2, "the two open games");
    assert.deepEqual(reads.filter((gameId) => ids.slice(0, 10).includes(gameId)), [], "no cancelled game's record read");
    assert.ok(!wire.queries.includes("LIST#fin"), "no listing of every money game");
    wire.reset();
    reads.length = 0;
    await world.service.sweepChain();
    await world.service.idle();
    assert.deepEqual(reads.filter((gameId) => ids.slice(0, 10).includes(gameId)), [], "nor by the chain sweep");
    assert.ok(!wire.queries.includes("LIST#fin"));
  });
});
