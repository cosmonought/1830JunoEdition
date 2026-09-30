// server/src/persistence/conformance/relayerRole.dynamoLocal.test.ts
//
// ==================================================================
//  LIVE-5 L5-6: THE RELAYER ROLE AND ITS TAKEOVER -- ON DYNAMODB LOCAL (the game table and the signing ledger)
// ==================================================================
//
// Runs ONLY against a DynamoDB Local named by GS_DYNAMODB_LOCAL_ENDPOINT (`npm run test:dynamodb-local`), like the rest
// of LIVE-5's DynamoDB suites; without one it FAILS with instructions.
//
//   §1 the takeover (`takeRelayerRole`): the ledger mint, then the mirror with the routing and pool conditions inside its
//      own transaction -- only the primary pool's current task; a routing flip or a pool takeover between the hint and
//      the mirror refused INSIDE the write; a mint whose mirror failed; the mirror's answer lost (landed / not landed,
//      and a late delivery that can never pass a newer mirror); the generation moving during the takeover; the old
//      relayer learning its loss from its ledger write or from its self-check; the mirror moved or damaged.
//   §2 the relayer's view of the chain intents: every write carries ROLE_RL instead of the game's HEAD fence -- a
//      demoted relayer writes nothing more, the new one writes intents of games it does not own, the owner's writes are
//      untouched, and the view creates nothing.
//   §3 end to end on the offline chain (ESCROW-3B's world, the DynamoDB ledger as the relayer's journal, the DynamoDB
//      intents with the relayer's role-fenced view): a takeover while the old relayer's attempt is live, and a takeover
//      at each boundary of the old relayer's pass -- admit, journal, store -- whose side effects never escape.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { GetItemCommand, PutItemCommand, TransactWriteItemsCommand, type AttributeValue, type DynamoDBClient, type TransactWriteItemsCommandInput } from "@aws-sdk/client-dynamodb";

import { createDynamoDbClient, deadline, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../../aws/awsClients";
import { headKey } from "../../aws/game/gameTable";
import { readRouting, setPrimaryPool } from "../../aws/game/routing";
import { readRelayerRole, relayerRoleKey, RelayerRoleUnreadableError } from "../../aws/game/relayerRole";
import { createDynamoIntentStore, RELAYER_ROLE_FENCED } from "../../aws/game/dynamoIntentStore";
import type { ResendTiming } from "../../aws/game/transact";
import { LEDGER_KEYS, openDynamoSigningLedger, type DynamoSigningLedger } from "../../aws/ledger/dynamoSigningLedger";
import { PoolWriter, PoolWriterNotCurrentError } from "../../aws/ownership/poolWriter";
import { ledgerFencedHook, NO_RELAYER_ROLE, RelayerRoleRefusedError, RelayerRoleUnknownError, takeRelayerRole, type RelayerRole } from "../../aws/ownership/relayerRole";
import { deferredIntent, isLiveAttempt, junoInstanceOf, newChainIntent, type ChainIntentRecord } from "../../escrow/chainIntents";
import { SigningJournalError } from "../../escrow/signingJournal";
import { RELAYER_EXECUTE } from "../../escrow/juno/junoContract";
import type { DigestSigner } from "../../escrow/juno/signer";
import { CHAIN_ID, CONTRACT, fundedGame, GAME_A, makeWorld, RELAYER_ADDRESS, VARIANTS, type World } from "../../escrow/escrow3bSupport";
import { ALICE, BOB, quietConsole } from "../../rooms/testSupport";
import { ConformanceTables, installFaults, newRunId, requireLocal } from "./dynamoLocal";
import { FaultScript, gate } from "./faults";

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

/** Resends are real; their pacing is not (no test waits on a clock). */
const TIMING: Partial<ResendTiming> = { maxResends: 2, windowMs: 60_000, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined };
const zeroWait = async () => undefined;

quietConsole();

after(async () => {
  for (const client of clients) client.destroy();
  await tables.dropAll();
  assert.deepEqual(tables.live, [], "every table this run made was dropped");
  admin.destroy();
});

async function freshClient(script?: FaultScript): Promise<DynamoDBClient> {
  const client = createDynamoDbClient(TARGET);
  await requireLocal(client);
  if (script !== undefined) installFaults(client, script);
  clients.push(client);
  return client;
}

function manualClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}
type Clock = ReturnType<typeof manualClock>;

const put = (table: string, item: Record<string, AttributeValue>) => admin.send(new PutItemCommand({ TableName: table, Item: item }), { abortSignal: deadline() });
const appgen = (generation: number) => ({ ...LEDGER_KEYS.appgen(), schema: N(1), current_generation: N(generation) });

async function fenceEpoch(ledger: string, account: string): Promise<number | null> {
  const answer = await admin.send(new GetItemCommand({ TableName: ledger, Key: LEDGER_KEYS.fence(account), ConsistentRead: true }), { abortSignal: deadline() });
  return answer.Item === undefined ? null : Number(answer.Item.epoch?.N);
}

async function roleTables(label: string): Promise<{ game: string; ledger: string }> {
  const game = await tables.create(`${label}-game`);
  const ledger = await tables.create(`${label}-ledger`);
  await put(ledger, appgen(1));
  return { game, ledger };
}

interface Task {
  readonly writer: PoolWriter;
  readonly lost: string[];
  /** The game-table client (faults, when scripted, are on this one only). */
  readonly client: DynamoDBClient;
  /** The ledger instance this task opened for the relayer account; its `onFenced` is the pool writer's loss. */
  readonly ledger: DynamoSigningLedger;
}

async function task(game: string, ledgerTable: string, pool: string, id: string, over: { clock?: Clock; script?: FaultScript; account?: string; ledgerScript?: FaultScript } = {}): Promise<Task> {
  const client = await freshClient(over.script);
  const ledgerClient = await freshClient(over.ledgerScript);
  const lost: string[] = [];
  const clock = over.clock ?? manualClock();
  const writer = await PoolWriter.take({ client, table: game, pool, task: id, now: clock.now, onLost: (reason) => lost.push(reason) });
  const ledger = await openDynamoSigningLedger(ledgerClient, { table: ledgerTable, generation: 1, relayer: { address: over.account ?? RELAYER_ADDRESS }, onFenced: ledgerFencedHook(writer), sleep: zeroWait, resends: 2 });
  return { writer, lost, client, ledger };
}

async function primary(game: string, pool: string): Promise<void> {
  const routing = await readRouting(admin, game);
  if (routing?.primary_pool === pool) return;
  const set = await setPrimaryPool(admin, game, { pool, expectedVersion: routing?.routing_version ?? null, by: "pipeline", now: 1 });
  assert.equal(set.kind, "set");
}

async function taken(t: Task, now: () => number = () => 1_000): Promise<RelayerRole> {
  const outcome = await takeRelayerRole(t.writer, { ledger: t.ledger, now, timing: TIMING });
  assert.equal(outcome.kind, "taken");
  return (outcome as { role: RelayerRole }).role;
}

const TX = (n: number) => n.toString(16).toUpperCase().padStart(64, "0");
const attemptEntry = (account: string, n: number) => ({ intent_id: "ab".repeat(32), tx_id: TX(n), account, account_sequence: String(n), expires_after_height: String(100 + n) });
const fencedJournal = (error: unknown) => error instanceof SigningJournalError && error.outcome === "fenced";

/* ==================================================================
    §1 THE TAKEOVER
   ================================================================== */
describe("§1 the relayer role takeover: the ledger mint, then the mirror", () => {
  test("only the primary pool's current task takes the role -- nothing is minted for a task the routing does not name; taken, both fences are the task's and the self-check watches them", async () => {
    const { game, ledger } = await roleTables("rl-primary");
    const a = await task(game, ledger, "pool-a", "task-a1");
    assert.deepEqual(await takeRelayerRole(a.writer, { ledger: a.ledger, now: () => 1_000 }), { kind: "not-primary", primary: null }, "no routing: not the relayer");
    await primary(game, "pool-b");
    assert.deepEqual(await takeRelayerRole(a.writer, { ledger: a.ledger, now: () => 1_000 }), { kind: "not-primary", primary: "pool-b" });
    assert.equal(await fenceEpoch(ledger, RELAYER_ADDRESS), null, "a task the routing does not name mints NOTHING (a mint would fence the real relayer)");
    await primary(game, "pool-a");
    const role = await taken(a);
    assert.equal(role.epoch, 1);
    assert.equal(a.ledger.relayerEpoch(), 1, "the ledger instance holds the fence it minted");
    assert.equal(await fenceEpoch(ledger, RELAYER_ADDRESS), 1);
    const mirror = await readRelayerRole(admin, game, RELAYER_ADDRESS);
    assert.deepEqual([mirror?.epoch, mirror?.task, mirror?.pool, mirror?.pool_epoch, mirror?.claim], [1, "task-a1", "pool-a", 1, role.record.claim]);
    assert.deepEqual(await a.writer.check(), { kind: "current" }, "the relayer probe holds");
    assert.equal(role.current(), true);
    await role.beforeSideEffect();
    assert.equal(NO_RELAYER_ROLE.current(), false);
    await assert.rejects(NO_RELAYER_ROLE.beforeSideEffect("sign"), PoolWriterNotCurrentError);
    assert.deepEqual(a.lost, []);
  });

  test("RACE: the routing flips between the hint and the mirror -- refused INSIDE the mirror's transaction: not the relayer; the mint that preceded it fenced the previous holder in the ledger (which exits) and nobody can use it; the next primary task takes a newer epoch", async () => {
    const { game, ledger } = await roleTables("rl-flip");
    await primary(game, "pool-a");
    const a1 = await task(game, ledger, "pool-a", "task-a1");
    await taken(a1);
    await primary(game, "pool-b");
    const script = new FaultScript();
    const b1 = await task(game, ledger, "pool-b", "task-b1", { script });
    const held = gate();
    script.add({ op: TWI, action: { kind: "stall", gate: held }, label: "the mirror waits" });
    const taking = takeRelayerRole(b1.writer, { ledger: b1.ledger, now: () => 2_000, timing: TIMING });
    await held.reached; // b1 read "primary: pool-b", minted epoch 2 in the ledger, and is about to mirror it
    assert.equal(await fenceEpoch(ledger, RELAYER_ADDRESS), 2, "the ledger half landed");
    await primary(game, "pool-a"); // the pipeline flips back
    held.release();
    assert.deepEqual(await taking, { kind: "not-primary", primary: "pool-a" });
    const mirror = await readRelayerRole(admin, game, RELAYER_ADDRESS);
    assert.deepEqual([mirror?.epoch, mirror?.task], [1, "task-a1"], "the mirror is untouched");
    assert.deepEqual(b1.lost, [], "a routing flip is not a pool loss");
    /* The previous holder: fenced in the ledger from the mint on -- its next attempt write is refused and it is lost. */
    await assert.rejects(a1.ledger.recordAttempt(attemptEntry(RELAYER_ADDRESS, 1)), fencedJournal);
    assert.equal(a1.lost.length, 1);
    assert.match(a1.lost[0], /newer relayer holds the relayer fence/);
    /* The next primary task (a1's restart, a2) takes a NEWER epoch; the mirror moves forward past b1's unused 2. */
    const a2 = await task(game, ledger, "pool-a", "task-a2");
    const role = await taken(a2);
    assert.equal(role.epoch, 3);
    assert.equal((await readRelayerRole(admin, game, RELAYER_ADDRESS))?.epoch, 3);
    await assert.rejects(b1.ledger.recordAttempt(attemptEntry(RELAYER_ADDRESS, 2)), fencedJournal, "and b1's unused mint is dead");
  });

  test("RACE: a newer task of the pool takes it between the hint and the mirror -- refused INSIDE the write; the stale task is lost and takes nothing; the current task takes the role", async () => {
    const { game, ledger } = await roleTables("rl-pool");
    await primary(game, "pool-a");
    const script = new FaultScript();
    const a1 = await task(game, ledger, "pool-a", "task-a1", { script });
    const held = gate();
    script.add({ op: TWI, action: { kind: "stall", gate: held } });
    const taking = takeRelayerRole(a1.writer, { ledger: a1.ledger, now: () => 1_000, timing: TIMING });
    await held.reached;
    const a2 = await task(game, ledger, "pool-a", "task-a2");
    held.release();
    await assert.rejects(taking, (error: unknown) => error instanceof PoolWriterNotCurrentError && error.lost === true);
    assert.equal(a1.lost.length, 1, "it knows it is lost");
    assert.equal(await readRelayerRole(admin, game, RELAYER_ADDRESS), null, "the stale task mirrored nothing");
    const role = await taken(a2);
    assert.equal(role.epoch, 2, "a newer epoch than the stale task's unused mint");
  });

  test("a stale task whose last good check is old mints NOTHING: the freshness gate before the mint finds it lost (a mint would fence the real relayer)", async () => {
    const { game, ledger } = await roleTables("rl-stale-mint");
    await primary(game, "pool-a");
    const clock = manualClock();
    const a1 = await task(game, ledger, "pool-a", "task-a1", { clock });
    const a2 = await task(game, ledger, "pool-a", "task-a2", { clock });
    const role = await taken(a2);
    clock.advance(6_000);
    await assert.rejects(takeRelayerRole(a1.writer, { ledger: a1.ledger, now: clock.now, timing: TIMING }), (error: unknown) => error instanceof PoolWriterNotCurrentError && error.lost === true);
    assert.equal(await fenceEpoch(ledger, RELAYER_ADDRESS), 1, "the current relayer's fence is untouched");
    assert.equal(role.current(), true);
    assert.deepEqual(await a2.writer.check(), { kind: "current" });
  });

  test("the mirror's answer lost: it landed -- the identical resend, or the read, settles it by its claim: taken and watched", async () => {
    const { game, ledger } = await roleTables("rl-lost");
    await primary(game, "pool-a");
    const resent = new FaultScript([{ op: TWI, nth: 1, action: { kind: "lose-answer" }, label: "the mirror lands; its answer is lost" }]);
    const a1 = await task(game, ledger, "pool-a", "task-a1", { script: resent });
    const role1 = await taken(a1);
    assert.deepEqual(resent.unfired(), []);
    assert.equal((await readRelayerRole(admin, game, RELAYER_ADDRESS))?.claim, role1.record.claim);
    const { game: game2, ledger: ledger2 } = await roleTables("rl-lost-read");
    await primary(game2, "pool-a");
    const read = new FaultScript([
      { op: TWI, nth: 1, action: { kind: "lose-answer" }, label: "the mirror lands; its answer is lost" },
      { op: TWI, nth: 2, action: { kind: "fail", code: "TimeoutError" }, label: "resend 1: no answer" },
      { op: TWI, nth: 3, action: { kind: "fail", code: "TimeoutError" }, label: "resend 2: no answer" },
    ]);
    const b1 = await task(game2, ledger2, "pool-a", "task-b1", { script: read });
    const role2 = await taken(b1);
    assert.deepEqual(read.unfired(), []);
    assert.equal((await readRelayerRole(admin, game2, RELAYER_ADDRESS))?.claim, role2.record.claim, "settled by the mirror's claim");
    assert.deepEqual(await b1.writer.check(), { kind: "current" });
  });

  test("the mirror's outcome UNKNOWN and not landed: never guessed -- not the relayer (RelayerRoleUnknownError); a retake mints and mirrors a newer epoch; the first request delivered LATE can never land over it", async () => {
    const { game, ledger } = await roleTables("rl-unknown");
    await primary(game, "pool-a");
    const script = new FaultScript([1, 2, 3].map((nth) => ({ op: TWI, nth, action: { kind: "fail" as const, code: "TimeoutError" }, label: `send ${nth}: no answer, never delivered` })));
    const a1 = await task(game, ledger, "pool-a", "task-a1", { script });
    await assert.rejects(takeRelayerRole(a1.writer, { ledger: a1.ledger, now: () => 1_000, timing: TIMING }), RelayerRoleUnknownError);
    assert.deepEqual(script.unfired(), []);
    assert.equal(await readRelayerRole(admin, game, RELAYER_ADDRESS), null);
    assert.deepEqual(a1.lost, [], "an unknown outcome is not a loss");
    const first = JSON.parse(script.calls.find((call) => call.op === TWI)?.detail ?? "null") as TransactWriteItemsCommandInput;
    assert.ok(first?.ClientRequestToken, "the first mirror request, as it was sent");
    const role = await taken(a1);
    assert.equal(role.epoch, 2, "the retake mints a newer epoch");
    /* The first request (epoch 1, its own token) delivered now: its `epoch < 1` condition can never pass epoch 2. */
    await assert.rejects(admin.send(new TransactWriteItemsCommand(first), { abortSignal: deadline() }), (error: Error) => error.name === "TransactionCanceledException");
    const mirror = await readRelayerRole(admin, game, RELAYER_ADDRESS);
    assert.deepEqual([mirror?.epoch, mirror?.claim], [2, role.record.claim]);
    assert.deepEqual(await a1.writer.check(), { kind: "current" });
  });

  test("the generation moves during the takeover: before the mint -> the ledger refuses it and the task is lost; between the mint and the mirror -> the mirror lands but the confirmation proves the loss", async () => {
    const { game, ledger } = await roleTables("rl-gen");
    await primary(game, "pool-a");
    const a1 = await task(game, ledger, "pool-a", "task-a1");
    await put(ledger, appgen(2));
    await assert.rejects(takeRelayerRole(a1.writer, { ledger: a1.ledger, now: () => 1_000, timing: TIMING }), fencedJournal);
    assert.match(a1.lost[0] ?? "", /generation/, "the ledger's onFenced made the task lost");
    assert.equal(await readRelayerRole(admin, game, RELAYER_ADDRESS), null);

    const { game: game2, ledger: ledger2 } = await roleTables("rl-gen-mid");
    await primary(game2, "pool-a");
    const script = new FaultScript();
    const b1 = await task(game2, ledger2, "pool-a", "task-b1", { script });
    const held = gate();
    script.add({ op: TWI, action: { kind: "stall", gate: held } });
    const taking = takeRelayerRole(b1.writer, { ledger: b1.ledger, now: () => 1_000, timing: TIMING });
    await held.reached; // minted under generation 1; about to mirror
    await put(ledger2, appgen(2)); // a restore adopted
    held.release();
    await assert.rejects(taking, (error: unknown) => error instanceof PoolWriterNotCurrentError && error.lost === true);
    assert.match(b1.lost[0] ?? "", /generation/);
    assert.equal((await readRelayerRole(admin, game2, RELAYER_ADDRESS))?.epoch, 1, "the mirror landed -- harmless: its ledger fence can record nothing");
    await assert.rejects(b1.ledger.recordAttempt(attemptEntry(RELAYER_ADDRESS, 1)), fencedJournal);
  });

  test("the old relayer learns its loss: from its next attempt write (the ledger's onFenced, no read needed), or from its self-check without any write (the probe reads the ledger fence)", async () => {
    const { game, ledger } = await roleTables("rl-old-write");
    await primary(game, "pool-a");
    const a = await task(game, ledger, "pool-a", "task-a1");
    await taken(a);
    await primary(game, "pool-b");
    const b = await task(game, ledger, "pool-b", "task-b1");
    assert.equal((await taken(b)).epoch, 2);
    await assert.rejects(a.ledger.recordAttempt(attemptEntry(RELAYER_ADDRESS, 1)), fencedJournal, "refused inside the ledger write");
    assert.equal(a.lost.length, 1, "the hook made the task lost at once");
    assert.match(a.lost[0], /newer relayer holds the relayer fence/);

    const { game: g2, ledger: l2 } = await roleTables("rl-old-check");
    await primary(g2, "pool-a");
    const c = await task(g2, l2, "pool-a", "task-c1");
    await taken(c);
    await primary(g2, "pool-b");
    const d = await task(g2, l2, "pool-b", "task-d1");
    await taken(d);
    assert.equal((await c.writer.check()).kind, "lost");
    assert.match(c.lost[0] ?? "", /relayer role is no longer this task's: the ledger's relayer fence/);
    await c.writer.check();
    assert.equal(c.lost.length, 1, "once");
  });

  test("RACE: another primary mirrored a NEWER epoch before this task's mirror landed -- refused by the mirror's own `epoch < r` condition: RelayerRoleRefusedError, never taken", async () => {
    const { game, ledger } = await roleTables("rl-newer");
    await primary(game, "pool-a");
    const script = new FaultScript();
    const a1 = await task(game, ledger, "pool-a", "task-a1", { script });
    const held = gate();
    script.add({ op: TWI, action: { kind: "stall", gate: held } });
    const taking = takeRelayerRole(a1.writer, { ledger: a1.ledger, now: () => 1_000, timing: TIMING });
    await held.reached; // a1 minted epoch 1
    await primary(game, "pool-b");
    const b1 = await task(game, ledger, "pool-b", "task-b1");
    assert.equal((await taken(b1)).epoch, 2);
    await primary(game, "pool-a"); // and back: a1's routing and pool conditions hold again
    held.release();
    await assert.rejects(taking, RelayerRoleRefusedError);
    const mirror = await readRelayerRole(admin, game, RELAYER_ADDRESS);
    assert.deepEqual([mirror?.epoch, mirror?.task], [2, "task-b1"], "the newer mirror stands");
    assert.deepEqual(a1.lost, []);
  });

  test("a task takes the role once: a second takeover by the same task is refused before anything is minted", async () => {
    const { game, ledger } = await roleTables("rl-twice");
    await primary(game, "pool-a");
    const a = await task(game, ledger, "pool-a", "task-a1");
    await taken(a);
    await assert.rejects(takeRelayerRole(a.writer, { ledger: a.ledger, now: () => 2_000, timing: TIMING }), RelayerRoleRefusedError);
    assert.equal(await fenceEpoch(ledger, RELAYER_ADDRESS), 1, "nothing minted");
    assert.deepEqual(await a.writer.check(), { kind: "current" }, "and the task is not lost");
  });

  test("a takeover whose confirming read could not tell is UNCONFIRMED: its first side effect reads both fences itself, even when the pool writer's last good check (from before the role) is fresh", async () => {
    const { game, ledger } = await roleTables("rl-unconfirmed");
    await primary(game, "pool-a");
    const ledgerScript = new FaultScript();
    const a = await task(game, ledger, "pool-a", "task-a1", { ledgerScript });
    /* The mint's own reads and write pass; the confirming read's APPGEN GetItem fails. The mint reads the fence
       (GetItem 1) and writes (TWI); the confirmation reads APPGEN (GetItem 2). */
    ledgerScript.add({ op: "GetItemCommand", nth: 2, action: { kind: "fail" }, label: "the confirming read of APPGEN fails" });
    const role = await taken(a);
    assert.deepEqual(ledgerScript.unfired(), []);
    /* A newer relayer before the first side effect (the pool writer's last good check is still fresh). */
    await primary(game, "pool-b");
    const b = await task(game, ledger, "pool-b", "task-b1");
    await taken(b);
    await assert.rejects(role.beforeSideEffect(), (error: unknown) => error instanceof PoolWriterNotCurrentError && error.lost === true, "the unconfirmed role reads its fences before its first side effect");
    assert.match(a.lost[0] ?? "", /relayer role is no longer this task's/);
  });

  test("the mirror alone moved -> lost; a mirror this build cannot read proves nothing (unknown: side effects wait, never lost) and is never overwritten by a takeover", async () => {
    const { game, ledger } = await roleTables("rl-mirror");
    await primary(game, "pool-a");
    const clock = manualClock();
    const a1 = await task(game, ledger, "pool-a", "task-a1", { clock });
    const role = await taken(a1);
    await put(game, { ...relayerRoleKey(RELAYER_ADDRESS), fmt: N(9), epoch: N(1), task: S("task-a1"), pool: S("pool-a"), pool_epoch: N(1), taken_at: N(0), claim: S(role.record.claim) });
    assert.equal((await a1.writer.check()).kind, "unknown", "damage is not a takeover");
    assert.deepEqual(a1.lost, []);
    clock.advance(6_000);
    await assert.rejects(role.beforeSideEffect(), (error: unknown) => error instanceof PoolWriterNotCurrentError && error.lost === false, "side effects wait");
    await assert.rejects(readRelayerRole(admin, game, RELAYER_ADDRESS), RelayerRoleUnreadableError);
    const b = await task(game, ledger, "pool-a", "task-a2", { clock });
    await assert.rejects(takeRelayerRole(b.writer, { ledger: b.ledger, now: () => 2_000, timing: TIMING }), RelayerRoleUnreadableError, "a takeover never overwrites a mirror it cannot read");
    /* A well-formed mirror of another takeover (the ledger fence untouched here): the probe proves the loss. */
    const { game: g2, ledger: l2 } = await roleTables("rl-mirror-moved");
    await primary(g2, "pool-a");
    const c = await task(g2, l2, "pool-a", "task-c1");
    const cRole = await taken(c);
    await put(g2, { ...relayerRoleKey(RELAYER_ADDRESS), fmt: N(1), epoch: N(5), task: S("task-z9"), pool: S("pool-a"), pool_epoch: N(1), taken_at: N(0), claim: S("another-claim") });
    assert.equal((await c.writer.check()).kind, "lost");
    assert.match(c.lost[0] ?? "", /mirror is at epoch 5/);
    assert.equal(cRole.current(), false);
  });
});

/* ==================================================================
    §2 THE RELAYER'S VIEW OF THE INTENTS: ROLE_RL INSTEAD OF THE GAME FENCE
   ================================================================== */
describe("§2 the relayer's view of the chain intents", () => {
  const intentFor = (now: number): ChainIntentRecord =>
    newChainIntent({
      game_id: GAME_A,
      instance: junoInstanceOf(CHAIN_ID, CONTRACT, "99"),
      key: { op: "finalize", seq: "3" },
      subject: { kind: "digest", digests: [{ codec: "18JUNO/v1", purpose: "settle", hex: "77".repeat(32) }] },
      op: { kind: "finalize", chain_game_id: "99", seq: "3" },
      msg_json: RELAYER_EXECUTE.finalize("99"),
      now,
    });

  test("every relayer write carries ROLE_RL: a demoted relayer writes nothing more (and learns it); the new relayer writes intents of a game it does not own; the owner's writes carry only the game fence; the view creates nothing", async () => {
    const { game, ledger } = await roleTables("rl-intents");
    await primary(game, "pool-a");
    const a = await task(game, ledger, "pool-a", "task-a1");
    const roleA = await taken(a);
    await put(game, { ...headKey(GAME_A), owner_pool: S("pool-a"), pool_epoch: N(a.writer.epoch), log_next_index: N(0), log_bytes: N(0) });
    const owner = createDynamoIntentStore({ client: a.client, table: game, fence: a.writer.fence, relayQueue: RELAYER_ADDRESS, timing: TIMING });
    const relayerA = createDynamoIntentStore({ client: a.client, table: game, fence: a.writer.fence, relayQueue: RELAYER_ADDRESS, timing: TIMING, relayerRole: roleA.intentStoreRole() });
    const intent = intentFor(5_000);
    assert.equal((await relayerA.create(intent)).kind, "failed", "the relayer's view creates no intent");
    assert.equal((await owner.create(intent)).kind, "created");
    const v2 = deferredIntent(intent, 6_000, 5_500, false);
    assert.equal((await relayerA.put(v2, 1)).kind, "committed", "the role holds: the relayer writes");
    /* A newer primary takes the role. */
    await primary(game, "pool-b");
    const b = await task(game, ledger, "pool-b", "task-b1");
    const roleB = await taken(b);
    const relayerB = createDynamoIntentStore({ client: b.client, table: game, fence: b.writer.fence, relayQueue: RELAYER_ADDRESS, timing: TIMING, relayerRole: roleB.intentStoreRole() });
    const v3 = deferredIntent(v2, 7_000, 6_500, false);
    assert.deepEqual(await relayerA.put(v3, 2), { kind: "definite", detail: RELAYER_ROLE_FENCED }, "the demoted relayer: refused INSIDE the write");
    assert.equal((await owner.load(GAME_A, intent.intent_id))?.record_version, 2, "nothing written");
    assert.equal((await a.writer.check()).kind, "lost", "and its self-check (asked for by the refusal) proves the loss");
    assert.equal((await relayerB.put(v3, 2)).kind, "committed", "the new relayer writes the intent of a game pool-a owns: ROLE_RL, not the game fence");
    const gameFencedB = createDynamoIntentStore({ client: b.client, table: game, fence: b.writer.fence, relayQueue: RELAYER_ADDRESS, timing: TIMING });
    assert.equal((await gameFencedB.put(deferredIntent(v3, 8_000, 7_500, false), 3)).kind, "definite", "pool-b's GAME-fenced view is refused: it does not own the game");
    assert.equal((await owner.put(deferredIntent(v3, 8_000, 7_500, false), 3)).kind, "committed", "the owner's writes never carry the role");
  });

  test("a damaged mirror refuses the relayer's write (nothing written) but proves no takeover: the self-check says unknown", async () => {
    const { game, ledger } = await roleTables("rl-intents-damage");
    await primary(game, "pool-a");
    const a = await task(game, ledger, "pool-a", "task-a1");
    const role = await taken(a);
    await put(game, { ...headKey(GAME_A), owner_pool: S("pool-a"), pool_epoch: N(a.writer.epoch), log_next_index: N(0), log_bytes: N(0) });
    const owner = createDynamoIntentStore({ client: a.client, table: game, fence: a.writer.fence, relayQueue: RELAYER_ADDRESS, timing: TIMING });
    const relayer = createDynamoIntentStore({ client: a.client, table: game, fence: a.writer.fence, relayQueue: RELAYER_ADDRESS, timing: TIMING, relayerRole: role.intentStoreRole() });
    const intent = intentFor(5_000);
    assert.equal((await owner.create(intent)).kind, "created");
    await put(game, { ...relayerRoleKey(RELAYER_ADDRESS), fmt: N(2), epoch: N(1), task: S("task-a1"), pool: S("pool-a"), pool_epoch: N(1), taken_at: N(0), claim: S(role.record.claim) });
    assert.deepEqual(await relayer.put(deferredIntent(intent, 6_000, 5_500, false), 1), { kind: "definite", detail: RELAYER_ROLE_FENCED });
    assert.equal((await a.writer.check()).kind, "unknown");
    assert.deepEqual(a.lost, []);
  });

  test("a mirror at the SAME epoch with another claim (as after a same-number re-mint) is not this task's: ROLE_RL names the claim, not only the epoch -- refused, and the self-check proves the loss", async () => {
    const { game, ledger } = await roleTables("rl-intents-claim");
    await primary(game, "pool-a");
    const a = await task(game, ledger, "pool-a", "task-a1");
    const role = await taken(a);
    await put(game, { ...headKey(GAME_A), owner_pool: S("pool-a"), pool_epoch: N(a.writer.epoch), log_next_index: N(0), log_bytes: N(0) });
    const owner = createDynamoIntentStore({ client: a.client, table: game, fence: a.writer.fence, relayQueue: RELAYER_ADDRESS, timing: TIMING });
    const relayer = createDynamoIntentStore({ client: a.client, table: game, fence: a.writer.fence, relayQueue: RELAYER_ADDRESS, timing: TIMING, relayerRole: role.intentStoreRole() });
    const intent = intentFor(5_000);
    assert.equal((await owner.create(intent)).kind, "created");
    await put(game, { ...relayerRoleKey(RELAYER_ADDRESS), fmt: N(1), epoch: N(1), task: S("task-a1"), pool: S("pool-a"), pool_epoch: N(1), taken_at: N(0), claim: S("another-claim") });
    assert.deepEqual(await relayer.put(deferredIntent(intent, 6_000, 5_500, false), 1), { kind: "definite", detail: RELAYER_ROLE_FENCED });
    assert.equal((await owner.load(GAME_A, intent.intent_id))?.record_version, 1, "nothing written");
    assert.equal((await a.writer.check()).kind, "lost");
    assert.match(a.lost[0] ?? "", /mirror is at epoch 1/);
  });
});

/* ==================================================================
    §3 END TO END ON THE OFFLINE CHAIN
   ================================================================== */
function countingKey() {
  const counter = { signed: 0 };
  const wrap = (inner: DigestSigner): DigestSigner => ({
    ...inner,
    async sign(bytes) {
      counter.signed += 1;
      return inner.sign(bytes);
    },
  });
  return { counter, wrap };
}

interface Seam {
  readonly journal: DynamoSigningLedger;
  readonly store: ReturnType<typeof createDynamoIntentStore>;
  readonly authority: RelayerRole;
}

interface Env {
  readonly game: string;
  readonly ledger: string;
  readonly clock: Clock;
  readonly a: Task;
  readonly roleA: RelayerRole;
  readonly seamA: Seam;
  readonly world: World;
  readonly key: ReturnType<typeof countingKey>;
  seam: Seam;
}

const relayerView = (t: Task, role: RelayerRole) => createDynamoIntentStore({ client: t.client, table: t.writer.table, fence: t.writer.fence, relayQueue: RELAYER_ADDRESS, timing: TIMING, relayerRole: role.intentStoreRole() });

/** pool-a is primary; its task a1 holds the relayer role and owns GAME_A; the world's service writes the intents through
 *  a1's GAME-fenced store, and its relayer through the seam (the role holder's ledger instance and role-fenced view). */
async function relayerWorld(label: string): Promise<Env> {
  const { game, ledger } = await roleTables(label);
  await primary(game, "pool-a");
  const clock = manualClock();
  const a = await task(game, ledger, "pool-a", "task-a1", { clock });
  const roleA = await taken(a, clock.now);
  await put(game, { ...headKey(GAME_A), owner_pool: S("pool-a"), pool_epoch: N(a.writer.epoch), log_next_index: N(0), log_bytes: N(0) });
  const owner = createDynamoIntentStore({ client: a.client, table: game, fence: a.writer.fence, relayQueue: RELAYER_ADDRESS, timing: TIMING });
  const seamA: Seam = { journal: a.ledger, store: relayerView(a, roleA), authority: roleA };
  const key = countingKey();
  const env = { game, ledger, clock, a, roleA, seamA, key, seam: seamA } as Env;
  (env as { world: World }).world = makeWorld({ intents: owner, journal: a.ledger, wrapRelayerKey: key.wrap, relayerSeam: () => env.seam });
  return env;
}

/** A newer primary (pool-b) takes the relayer role; the world's NEXT relayer (after `restart`) is that task's. */
async function takeOver(env: Env, id = "task-b1"): Promise<{ readonly b: Task; readonly role: RelayerRole; readonly seam: Seam }> {
  await primary(env.game, "pool-b");
  const b = await task(env.game, env.ledger, "pool-b", id, { clock: env.clock });
  const role = await taken(b, env.clock.now);
  const seam: Seam = { journal: b.ledger, store: relayerView(b, role), authority: role };
  env.seam = seam;
  return { b, role, seam };
}

async function pendingStart(world: World): Promise<void> {
  assert.ok((await world.service.createMoneyGame(GAME_A)).ok);
  const chainGameId = await fundedGame(world, GAME_A);
  assert.ok((await world.service.bindChainGame(GAME_A, chainGameId, VARIANTS)).ok);
  assert.ok((await world.service.requestStart(GAME_A, [{ player_id: ALICE }, { player_id: BOB }])).ok);
}

const startOf = async (world: World): Promise<ChainIntentRecord> => (await world.intents.listGame(GAME_A)).find((intent) => intent.op.kind === "start") as ChainIntentRecord;
const started = (world: World) => async () => (await world.financial.load(GAME_A))?.chain.started !== null;

describe("§3 end to end: the old relayer's side effects never escape a takeover", () => {
  test("a takeover while the old relayer's attempt is LIVE: the old task runs nothing and its ledger and intent writes are refused; the new relayer observes the live attempt, signs nothing new, and the same bytes land", async () => {
    const env = await relayerWorld("e2e-live");
    const world = env.world;
    await pendingStart(world);
    await world.relayer.pass(); // a1: sign, journal (ledger epoch 1), store (ROLE_RL 1), broadcast -> the mempool
    const live = (await startOf(world)).attempts[0];
    assert.ok(live !== undefined && isLiveAttempt(live));
    assert.deepEqual(world.chain.broadcasts, [live.tx_hash]);
    const old = world.relayer;
    const { b } = await takeOver(env);
    await world.restart(); // the new relayer: its load reads the journal (ledger) and the intents
    assert.equal((await env.a.writer.check()).kind, "lost", "the old task's self-check proves the loss");
    await old.pass();
    assert.deepEqual(world.chain.broadcasts, [live.tx_hash], "the old worker runs no pass");
    await assert.rejects(env.a.ledger.recordAttempt(attemptEntry(RELAYER_ADDRESS, 9)), fencedJournal, "its ledger writes are refused");
    const current = await startOf(world);
    assert.equal((await env.seamA.store.put(deferredIntent(current, env.clock.now(), env.clock.now(), false), current.record_version)).kind, "definite", "its intent writes are refused (ROLE_RL)");
    const signedBefore = env.key.counter.signed;
    world.clock.now += 5_000;
    await world.relayer.pass();
    assert.equal(env.key.counter.signed, signedBefore, "the new relayer signs nothing while the attempt is live");
    assert.equal((await startOf(world)).attempts.length, 1);
    await world.drive(started(world));
    const final = await startOf(world);
    assert.equal(final.confirmation?.tx_hash, live.tx_hash, "the old attempt's bytes landed: one transaction for the sequence");
    assert.equal(env.key.counter.signed, signedBefore);
    assert.ok(world.chain.broadcasts.every((hash) => hash === live.tx_hash));
    const journalled = await b.ledger.allAttempts(RELAYER_ADDRESS);
    assert.deepEqual(journalled.map((entry) => entry.tx_id), [live.tx_hash], "exactly the old relayer's one attempt is in the ledger");
  });

  test("a takeover at the ADMIT boundary: inside the gate's freshness window the stale task may still get a signature -- the ledger refuses its attempt: nothing stored, nothing broadcast, the task lost; the new relayer signs and the Start lands", async () => {
    const env = await relayerWorld("e2e-admit");
    const world = env.world;
    await pendingStart(world);
    const service = world.service as unknown as { admit: (intent: ChainIntentRecord) => Promise<unknown> };
    const original = service.admit.bind(world.service);
    let tookOver = false;
    service.admit = async (intent) => {
      const answer = await original(intent);
      if (!tookOver) {
        tookOver = true;
        await takeOver(env);
      }
      return answer; // "ok" -- said before the takeover
    };
    await world.relayer.pass();
    assert.ok(tookOver);
    assert.equal(env.key.counter.signed, 1, "the window: a1's last good check was fresh, so its sign gate passed");
    assert.deepEqual(await env.a.ledger.allAttempts(RELAYER_ADDRESS), [], "the ledger refused a1's attempt (a newer relayer fence)");
    const intent = await startOf(world);
    assert.equal(intent.attempts.length, 0, "nothing stored");
    assert.equal(intent.retry.failures, 0, "no failure counted");
    assert.deepEqual(world.chain.broadcasts, [], "nothing broadcast");
    assert.equal(env.a.lost.length, 1, "the ledger's onFenced made a1 lost");
    await world.restart();
    await world.drive(started(world));
    assert.equal(env.key.counter.signed, 2, "the new relayer signed its own attempt");
    assert.equal(world.chain.broadcasts.length, 1);
  });

  test("a takeover between the JOURNAL and the STORE: the old task's store write is refused by ROLE_RL, nothing is broadcast; its journalled attempt keeps the account's sequence (the new relayer's forgotten-attempt guard) until the chain passes its expiry; then the new relayer signs", async () => {
    const env = await relayerWorld("e2e-journal");
    const world = env.world;
    await pendingStart(world);
    const ledgerA = env.a.ledger as unknown as { recordAttempt: (entry: unknown) => Promise<void> };
    const original = ledgerA.recordAttempt.bind(env.a.ledger);
    let tookOver = false;
    ledgerA.recordAttempt = async (entry) => {
      await original(entry);
      if (!tookOver) {
        tookOver = true;
        await takeOver(env);
      }
    };
    await world.relayer.pass();
    assert.ok(tookOver);
    const journalled = await env.a.ledger.allAttempts(RELAYER_ADDRESS);
    assert.equal(journalled.length, 1, "journalled under a1's fence, before the takeover");
    assert.equal((await startOf(world)).attempts.length, 0, "never stored: ROLE_RL refused it");
    assert.deepEqual(world.chain.broadcasts, [], "never broadcast");
    assert.equal((await env.a.writer.check()).kind, "lost");
    await world.restart();
    await world.relayer.pass();
    assert.equal(env.key.counter.signed, 1, "the new relayer signs nothing while a journalled attempt may still land");
    assert.equal(world.relayer.status().forgotten_guard?.attempts, 1);
    await world.drive(started(world), 60);
    assert.equal(env.key.counter.signed, 2, "after the old attempt's expiry passed, a new attempt at the chain's sequence");
    assert.notEqual((await startOf(world)).confirmation?.tx_hash, journalled[0].tx_id, "the old bytes never escaped");
  });

  test("a takeover between the STORE and the BROADCAST, past the gate's freshness window: the old task withholds the broadcast (its self-check reads the moved fences); the stored attempt is broadcast by the new relayer -- the same bytes, nothing new signed", async () => {
    const env = await relayerWorld("e2e-store");
    const world = env.world;
    await pendingStart(world);
    const store = env.seamA.store as unknown as { put: (next: ChainIntentRecord, expected: number) => Promise<unknown> };
    const original = store.put.bind(env.seamA.store);
    let tookOver = false;
    store.put = async (next, expected) => {
      const answer = await original(next, expected);
      if (!tookOver && next.attempts.length > 0) {
        tookOver = true;
        await takeOver(env);
        env.clock.advance(6_000); // the old task's last good check is now older than the freshness window
      }
      return answer;
    };
    await world.relayer.pass();
    assert.ok(tookOver);
    const stored = (await startOf(world)).attempts[0];
    assert.equal(stored?.phase, "signed", "stored, never handed to a node");
    assert.deepEqual(world.chain.broadcasts, [], "withheld");
    assert.equal(env.a.lost.length, 1, "the gate's self-check proved the loss");
    await world.restart();
    await world.drive(started(world));
    assert.equal((await startOf(world)).confirmation?.tx_hash, stored.tx_hash);
    assert.equal(env.key.counter.signed, 1, "nothing new signed");
    assert.deepEqual([...new Set(world.chain.broadcasts)], [stored.tx_hash]);
  });

  test("the same, INSIDE the freshness window (the narrow stale window the gate cannot close): what the old task hands out is exactly the stored, journalled attempt the new relayer observes -- one transaction for the sequence, nothing new signed, nothing authoritative decided by the stale task", async () => {
    const env = await relayerWorld("e2e-window");
    const world = env.world;
    await pendingStart(world);
    const store = env.seamA.store as unknown as { put: (next: ChainIntentRecord, expected: number) => Promise<unknown> };
    const original = store.put.bind(env.seamA.store);
    let tookOver = false;
    store.put = async (next, expected) => {
      const answer = await original(next, expected);
      if (!tookOver && next.attempts.length > 0) {
        tookOver = true;
        await takeOver(env);
      }
      return answer;
    };
    await world.relayer.pass();
    const stored = (await startOf(world)).attempts[0];
    assert.equal(world.chain.broadcasts.length, 1, "the stale task's gate still vouched for it (a check within 5 s)");
    assert.equal(world.chain.broadcasts[0], stored.tx_hash, "and what it handed out is the journalled, stored attempt");
    assert.equal((await startOf(world)).attempts[0].phase, "signed", "its broadcast result was refused by ROLE_RL: the store still says signed");
    await world.restart();
    await world.drive(started(world));
    assert.equal((await startOf(world)).confirmation?.tx_hash, stored.tx_hash);
    assert.equal(env.key.counter.signed, 1);
  });
});

