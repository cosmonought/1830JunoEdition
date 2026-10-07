// server/src/persistence/conformance/l6_4Recovery.dynamoLocal.test.ts
//
// ==================================================================
//  LIVE-6 L6-4: GENERATION ADOPTION AND THE IDENTITY RESTORE -- ON DYNAMODB LOCAL
// ==================================================================
//
// Runs ONLY against a DynamoDB Local named by GS_DYNAMODB_LOCAL_ENDPOINT (`npm run test:dynamodb-local`); without one it
// FAILS with instructions. Real tables; the certified L5 substrate as built; faults by client proxies (an answer lost
// after the write landed; no answer and nothing sent).
//
//   §A APPGEN adoption: the exact CAS; an idempotent re-run; two adopters racing (one wins, the other writes nothing);
//      a stale expectation; an uncertain answer settled by reading (landed -> committed; not landed -> unknown, and the
//      re-run commits once); backwards / same / reused generations refused; a newer or damaged APPGEN refused; an
//      unprepared target refused; no APPGEN refused -- the dry run writes nothing.
//   §B the restored game table's preparation (from exactly the copied source marker; idempotent; not a copy: refused).
//   §C the fence reaction (Part E): after an adoption the old task's pool writer proves the loss once, KMS signs are
//      withheld, the ledger's reservations and attempts and the SEC# journal are refused, nothing old adopts the new
//      generation, and only a restart with the new generation AND the prepared table starts; the old task's runtime
//      exits 3 on its own self-check.
//   §D the identity restore: the dry run writes nothing; an interrupted replay leaves the table unserved (a serving load
//      and a serving takeover are refused) and resumes to the same end; the restored identity signs every session out,
//      keeps every security action, follows the password chain (PHASE 3 FINAL: accounts with an Authorization Wallet),
//      reviews a LEGACY profile's unconfirmed key rotation; a re-run of a completed restore writes nothing; a journal
//      changed during the replay, or a malformed one, leaves it unserved.
//   §E the operator commands: plan by default, no secret in any answer.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { GetItemCommand, PutItemCommand, ScanCommand, TransactWriteItemsCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createDynamoDbClient, deadline, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../../aws/awsClients";
import { poolKey } from "../../aws/game/gameTable";
import { bootstrapGenerationMarker, generationMarkerItem, prepareRestoredTable, planPreparation, readGenerationMarker, type PrepareRestoredTable } from "../../aws/game/generationMarker";
import { readRouting, setPrimaryPool } from "../../aws/game/routing";
import { createDynamoIdentityStore, identityServingChecks, IdentityRestoreIncompleteError, IdentityRoleRefusedError, readIdentityRole, takeOverIdentityWriter } from "../../aws/identity/dynamoIdentityStore";
import { createDynamoSecurityJournal, securityEventKey } from "../../aws/identity/dynamoSecurityJournal";
import { applyIdentityRestore, inspectIdentityRestore, planIdentityRestore, type IdentityRestoreRequest } from "../../aws/identity/identityRestore";
import { adoptGeneration, AppGenerationUnreadableError, appgenHistoryKey, planAdoption, readAppGeneration, type AdoptionRequest } from "../../aws/ledger/appGeneration";
import { LEDGER_KEYS, openDynamoSigningLedger } from "../../aws/ledger/dynamoSigningLedger";
import { PoolWriter } from "../../aws/ownership/poolWriter";
import { generationProbe, takeIdentityWriterRole } from "../../aws/ownership/roles";
import { preparedMarkerCheck, assertPrintable } from "../../aws/recovery/recoveryOps";
import { runRecoveryCommand } from "../../aws/recovery/recoveryCli";
import { AwsStartupError, startAwsRuntime } from "../../aws/runtime/awsRuntime";
import { realAwsSubstrate } from "../../aws/runtime/awsSubstrate";
import { gatedKmsClient } from "../../aws/runtime/kmsGate";
import { AWS_RUNTIME_CONFIG_FORMAT, parseAwsRuntimeConfig } from "../../aws/runtime/runtimeConfig";
import { SignerError } from "../../escrow/juno/signer";
import { SigningJournalError } from "../../escrow/signingJournal";
import { readSessionCookie, type SessionCookieRead } from "../../identity/cookies";
import { familyIdOf, mintPrincipalId, mintProfileId, mintRecoveryKey, mintSecret, mintSessionId, secretHash } from "../../identity/ids";
import { SECURITY_EVENT_FORMAT, SECURITY_EVENT_VERSION, type SecurityEvent } from "../../identity/securityEvents";
import { IdentityService, type SecurityEventDraft } from "../../identity/sessions";
import type { Principal, Profile, Session, SessionFamily } from "../../identity/store";
import { createAccountWith, keplrAccount } from "../../testSupport/authorizationWallets";
import { createMemoryOpsRecorder } from "../opsRecorder";
import { StoreDefiniteError } from "../storeResult";
import { quietConsole } from "../../rooms/testSupport";
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
const N = (value: number): AttributeValue => ({ N: String(value) });
const S = (value: string): AttributeValue => ({ S: value });
const noSleep = async () => undefined;

quietConsole();

after(async () => {
  await tables.dropAll();
  assert.deepEqual(tables.live, [], "every table this run made was dropped");
  admin.destroy();
});

type Item = Record<string, AttributeValue>;

async function get(table: string, key: Item): Promise<Item | null> {
  return (await admin.send(new GetItemCommand({ TableName: table, Key: key, ConsistentRead: true }), { abortSignal: deadline() })).Item ?? null;
}
async function put(table: string, item: Item): Promise<void> {
  await admin.send(new PutItemCommand({ TableName: table, Item: item }), { abortSignal: deadline() });
}
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
const sortedJson = (items: Item[]) => JSON.stringify(items.map((item) => JSON.stringify(item)).sort());
/** A point-in-time restore, as DynamoDB makes one: a NEW table holding exactly the source's items. */
async function restoreCopy(source: string, label: string): Promise<string> {
  const copy = await tables.create(label);
  for (const item of await scanAll(source)) await put(copy, item);
  return copy;
}

/** A client whose TransactWriteItems misbehave: `lose` -- sent, then the answer is lost (the write landed); `drop` --
 *  never sent, no answer. `after` of them pass first. Every other command passes. */
function faulty(mode: "lose" | "drop", options: { after?: number; times?: number } = {}): DynamoDBClient {
  let seen = 0;
  let faults = 0;
  const proxy = {
    send: async (command: unknown, extra?: unknown) => {
      if (command instanceof TransactWriteItemsCommand) {
        seen += 1;
        if (seen > (options.after ?? 0) && faults < (options.times ?? Infinity)) {
          faults += 1;
          if (mode === "lose") await admin.send(command as never, extra as never);
          throw Object.assign(new Error(`injected: the answer was ${mode === "lose" ? "lost" : "never given"}`), { name: "TimeoutError" });
        }
      }
      return admin.send(command as never, extra as never);
    },
  };
  return proxy as unknown as DynamoDBClient;
}

/* ------------------------------------------------------------------ */
/* The generation world: a ledger, the old game table g1, a restored g2 */
/* ------------------------------------------------------------------ */

interface GenWorld {
  readonly ledger: string;
  readonly g1: string;
  readonly g2: string;
  readonly request: AdoptionRequest;
  readonly prepare: PrepareRestoredTable;
}

async function genWorld(label: string, options: { prepare?: boolean; appgen?: Item | null } = {}): Promise<GenWorld> {
  const ledger = await tables.create(`${label}-ledger`);
  const g1 = await tables.create(`${label}-g1`);
  if (options.appgen !== null) await put(ledger, options.appgen ?? { ...LEDGER_KEYS.appgen(), schema: N(1), current_generation: N(1) });
  await put(g1, generationMarkerItem(bootstrapGenerationMarker({ generation: 1, gameTable: g1, by: "l5-8-bootstrap", now: 1 })));
  const routing = await readRouting(admin, g1);
  assert.equal((await setPrimaryPool(admin, g1, { pool: "p1", expectedVersion: routing?.routing_version ?? null, by: "pipeline", now: 1 })).kind, "set");
  const g2 = await restoreCopy(g1, `${label}-g2`);
  const prepare: PrepareRestoredTable = { gameTable: g2, generation: 2, restoredFrom: { generation: 1, table: g1 }, restorePoint: 1_000, restoreId: `r-${label}`.slice(0, 60), by: "op-drill", now: 2_000 };
  if (options.prepare !== false) assert.equal((await prepareRestoredTable(admin, g2, prepare)).kind, "prepared");
  return { ledger, g1, g2, prepare, request: { expected: 1, generation: 2, gameTable: g2, restoreId: prepare.restoreId, by: "op-drill" } };
}

const check = preparedMarkerCheck(admin);
const adopt = (w: GenWorld, request: AdoptionRequest = w.request, client: DynamoDBClient = admin) => adoptGeneration(client, w.ledger, request, check, { now: () => 3_000, sleep: noSleep });

/* ==================================================================
    §A APPGEN ADOPTION
   ================================================================== */
describe("§A APPGEN adoption: exact compare-and-swap, never guessed", () => {
  test("the exact CAS: APPGEN moves 1 -> 2 with its evidence and history item in ONE transaction; the dry run before it wrote nothing; a re-run is already-adopted and writes nothing", async () => {
    const w = await genWorld("a1");
    const before = await scanAll(w.ledger);
    assert.equal((await planAdoption(admin, w.ledger, w.request, check)).kind, "ready");
    assert.equal(sortedJson(await scanAll(w.ledger)), sortedJson(before), "the dry run wrote nothing");
    const done = await adopt(w);
    assert.equal(done.kind, "committed");
    const appgen = await readAppGeneration(admin, w.ledger);
    assert.equal(appgen?.current_generation, 2);
    assert.deepEqual({ ...appgen?.adoption, adopted_at: 0 }, { previous_generation: 1, adopted_at: 0, adopted_by: "op-drill", restore_id: w.request.restoreId, game_table: w.g2, claim: done.evidence.token });
    const history = await get(w.ledger, appgenHistoryKey(2));
    assert.equal(history?.claim?.S, done.evidence.token, "the history item is the same write's");
    const after = await scanAll(w.ledger);
    const again = await adopt(w);
    assert.equal(again.kind, "already-adopted");
    assert.equal(sortedJson(await scanAll(w.ledger)), sortedJson(after), "an idempotent re-run writes nothing");
  });

  test("two adopters race for the same move: exactly one commits; the other is a conflict and wrote nothing; a stale expectation is a conflict", async () => {
    const w = await genWorld("a2");
    const other = await restoreCopy(w.g1, "a2-g2b");
    const otherRestore = "r-a2-other";
    assert.equal((await prepareRestoredTable(admin, other, { ...w.prepare, gameTable: other, restoreId: otherRestore })).kind, "prepared");
    const results = await Promise.all([adopt(w), adopt(w, { ...w.request, gameTable: other, restoreId: otherRestore })]);
    const kinds = results.map((result) => result.kind).sort();
    assert.deepEqual(kinds, ["committed", "conflict"], JSON.stringify(results.map((result) => ("detail" in result ? result.detail : result.kind))));
    const winner = results.find((result) => result.kind === "committed");
    const appgen = await readAppGeneration(admin, w.ledger);
    assert.equal(appgen?.adoption?.claim, winner?.evidence.token, "the winner's claim; never overwritten by the loser");
    /* A later adoption from a STALE expectation (1) is refused; nothing moves. */
    const g3 = await restoreCopy(w.g1, "a2-g3");
    assert.equal((await prepareRestoredTable(admin, g3, { ...w.prepare, gameTable: g3, generation: 3, restoreId: "r-a2-three" })).kind, "prepared");
    const stale = await adopt(w, { ...w.request, generation: 3, gameTable: g3, restoreId: "r-a2-three" });
    assert.equal(stale.kind, "conflict");
    assert.equal((await readAppGeneration(admin, w.ledger))?.current_generation, 2);
  });

  test("two adopters that BOTH passed every read (1 -> 2 and 1 -> 3, released together at the write): the compare-and-swap inside the write lets exactly one land -- APPGEN never passes over a concurrent move", async () => {
    const w = await genWorld("a2r");
    const g3 = await restoreCopy(w.g1, "a2r-g3");
    assert.equal((await prepareRestoredTable(admin, g3, { ...w.prepare, gameTable: g3, generation: 3, restoreId: "r-a2r-three" })).kind, "prepared");
    /* A barrier: each adopter's transaction waits until BOTH have reached their write (so both planned against 1). */
    const waiting: Array<() => void> = [];
    const barrier = {
      send: async (command: unknown, extra?: unknown) => {
        if (command instanceof TransactWriteItemsCommand && waiting.length < 2) {
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
            if (waiting.length === 2) for (const release of waiting) release();
          });
        }
        return admin.send(command as never, extra as never);
      },
    } as unknown as DynamoDBClient;
    const results = await Promise.all([adopt(w, w.request, barrier), adopt(w, { ...w.request, generation: 3, gameTable: g3, restoreId: "r-a2r-three" }, barrier)]);
    assert.deepEqual(results.map((result) => result.kind).sort(), ["committed", "conflict"]);
    const winner = results.find((result) => result.kind === "committed");
    const appgen = await readAppGeneration(admin, w.ledger);
    assert.equal(appgen?.adoption?.claim, winner?.evidence.token);
    assert.equal(appgen?.adoption?.previous_generation, 1, "moved once, from 1: never 1 -> 2 -> 3 by two runs that both read 1");
    const histories = [await get(w.ledger, appgenHistoryKey(2)), await get(w.ledger, appgenHistoryKey(3))].filter((item) => item !== null);
    assert.equal(histories.length, 1, "the loser's history item was not written");
  });

  test("an uncertain answer is settled by reading: landed (answer lost, every resend lost too) -> committed; never sent -> unknown, APPGEN untouched, and the re-run commits exactly once", async () => {
    const landed = await genWorld("a3");
    const lost = await adopt(landed, landed.request, faulty("lose"));
    assert.equal(lost.kind, "committed", "the settling read found OUR claim on both items");
    assert.equal((await readAppGeneration(admin, landed.ledger))?.adoption?.claim, lost.evidence.token);

    const dropped = await genWorld("a3b");
    const unknown = await adopt(dropped, dropped.request, faulty("drop"));
    assert.equal(unknown.kind, "unknown");
    assert.equal((await readAppGeneration(admin, dropped.ledger))?.current_generation, 1, "nothing moved");
    assert.equal(await get(dropped.ledger, appgenHistoryKey(2)), null);
    const rerun = await adopt(dropped);
    assert.equal(rerun.kind, "committed");
    assert.equal((await adopt(dropped)).kind, "already-adopted");
  });

  test("backwards, the same, or a reused generation is refused; nothing written", async () => {
    const w = await genWorld("a4");
    for (const generation of [1, 0]) {
      const answer = await adopt(w, { ...w.request, generation });
      assert.equal(answer.kind, "refused", String(generation));
    }
    /* A generation number that was adopted before (its history item exists) is never adopted again. */
    await put(w.ledger, { ...appgenHistoryKey(2), schema: N(1), kind: S("appgen-adoption"), generation: N(2), previous_generation: N(1), adopted_at: N(1), adopted_by: S("earlier"), restore_id: S("r-earlier"), game_table: S("gs-earlier-g2"), claim: S("00000000-0000-4000-8000-000000000000") });
    const before = await scanAll(w.ledger);
    const reused = await adopt(w);
    assert.equal(reused.kind, "conflict");
    assert.match((reused as { detail: string }).detail, /never adopted twice/);
    assert.equal(sortedJson(await scanAll(w.ledger)), sortedJson(before));
  });

  test("a newer-format or damaged APPGEN is refused (never overwritten); no APPGEN is refused (the bootstrap is L5-8's); an unprepared target is refused", async () => {
    const newer = await genWorld("a5n", { appgen: { ...LEDGER_KEYS.appgen(), schema: N(2), current_generation: N(1) } });
    await assert.rejects(adopt(newer), (error: unknown) => error instanceof AppGenerationUnreadableError && error.format === "newer");
    assert.equal((await get(newer.ledger, LEDGER_KEYS.appgen()))?.schema?.N, "2", "untouched");
    const damaged = await genWorld("a5d", { appgen: { ...LEDGER_KEYS.appgen(), schema: N(1), current_generation: N(1), stray: S("x") } });
    await assert.rejects(adopt(damaged), (error: unknown) => error instanceof AppGenerationUnreadableError && error.format === "corrupt");
    const none = await genWorld("a5z", { appgen: null });
    const refused = await adopt(none);
    assert.equal(refused.kind, "refused");
    assert.match((refused as { detail: string }).detail, /bootstrap/);
    const unprepared = await genWorld("a5u", { prepare: false });
    const notReady = await adopt(unprepared);
    assert.equal(notReady.kind, "refused");
    assert.match((notReady as { detail: string }).detail, /not prepared/);
    assert.equal((await readAppGeneration(admin, unprepared.ledger))?.current_generation, 1);
  });
});

/* ==================================================================
    §B THE RESTORED TABLE'S PREPARATION
   ================================================================== */
describe("§B the restored game table is prepared from exactly the copied source marker", () => {
  test("plan (writes nothing) -> prepared -> already-prepared; a table that is not a copy of the named source, or has no marker, is refused", async () => {
    const w = await genWorld("b1", { prepare: false });
    const copied = await scanAll(w.g2);
    assert.equal((await planPreparation(admin, w.g2, w.prepare)).kind, "ready");
    assert.equal(sortedJson(await scanAll(w.g2)), sortedJson(copied), "the plan wrote nothing");
    const first = await prepareRestoredTable(admin, w.g2, w.prepare);
    assert.equal(first.kind, "prepared");
    const marker = await readGenerationMarker(admin, w.g2);
    assert.deepEqual({ generation: marker?.generation, origin: marker?.origin, from: marker?.restored_from_generation, table: marker?.game_table }, { generation: 2, origin: "restore", from: 1, table: w.g2 });
    assert.equal((await prepareRestoredTable(admin, w.g2, w.prepare)).kind, "already-prepared");
    assert.equal((await prepareRestoredTable(admin, w.g2, { ...w.prepare, restoreId: "r-other" })).kind, "refused", "prepared already, for another restore");
    assert.equal((await prepareRestoredTable(admin, w.g2, { ...w.prepare, restoredFrom: { generation: 1, table: "gs-some-other-table" } })).kind, "refused", "not a copy of that source");
    const bare = await tables.create("b1-bare");
    assert.equal((await prepareRestoredTable(admin, bare, { ...w.prepare, gameTable: bare })).kind, "refused", "no marker: not a copy of a marked table");
    assert.equal((await prepareRestoredTable(admin, w.g1, w.prepare)).kind, "refused", "the table written must be the request's own (never the source's marker)");
    assert.equal((await readGenerationMarker(admin, w.g1))?.generation, 1, "the source is never touched");
  });
});

/* ==================================================================
    §C THE FENCE REACTION (Part E)
   ================================================================== */
const LEDGER_ARN = "arn:aws:dynamodb:us-east-1:210987654321:table/gs-l64-ledger";
const config = (over: Record<string, unknown>) =>
  parseAwsRuntimeConfig({ format: AWS_RUNTIME_CONFIG_FORMAT, environment: "local", region: "us-east-1", pool: "p1", generation: 1, game_table: "gs-l64-game-g1", identity_table: "gs-l64-identity", ledger_table_arn: LEDGER_ARN, escrow: null, ...over });

/** A runtime starter over the real substrate: the given ledger and identity table, the game table and generation per start. */
function starter(ledger: string, identity: string, clients: DynamoDBClient[]) {
  return async (task: string, generation: number, game: string, record: number[] = []) => {
    const app = createDynamoDbClient(TARGET);
    await requireLocal(app);
    clients.push(app);
    const doc = config({ generation, game_table: game });
    return startAwsRuntime({
      config: doc,
      escrowConfig: null,
      server: { mode: "production", allowedOrigins: ["https://play.example"], trustedProxyHops: 1 },
      build: "l6-4-ddb",
      port: 0,
      bindHost: "127.0.0.1",
      moneySwitch: undefined,
      task,
      substrate: realAwsSubstrate({ config: doc, clients: { app, ledger: app }, tables: { game, identity, ledger }, timing: { maxResends: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: noSleep } }),
      ops: createMemoryOpsRecorder(),
      now: () => Date.now(),
      log: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      exit: (code) => record.push(code),
      timing: { sweepEveryMs: 3_600_000, sweepRetryMs: 20, relayerRetryMs: 3_600_000, failFastDelayMs: 5, drainEscrowMs: 500, drainOwnershipMs: 500, drainChainFactsMs: 200, drainIdentityMs: 1_000 },
    });
  };
}

describe("§C after an adoption every old writer is fenced, and nothing follows APPGEN", () => {
  test("the old task's pool writer proves the loss ONCE; KMS signs withheld; reservations, attempts and SEC# events refused; the old generation cannot reopen; the new one only with its prepared table", async () => {
    const w = await genWorld("c1");
    const client = createDynamoDbClient(TARGET);
    await requireLocal(client);
    const losses: string[] = [];
    const writer = await PoolWriter.take({ client, table: w.g1, pool: "p1", task: "t-old", now: () => Date.now(), onLost: (reason) => losses.push(reason), freshForMs: 1 });
    writer.watchGeneration(generationProbe(client, w.ledger, 1));
    const fencedHooks: string[] = [];
    const ledger = await openDynamoSigningLedger(client, { table: w.ledger, generation: 1, relayer: { address: "juno1relayer0" }, onFenced: (which) => fencedHooks.push(which), sleep: noSleep });
    await ledger.takeOverRelayer();
    const journal = createDynamoSecurityJournal(client, w.ledger, { generation: 1, sleep: noSleep, onFenced: () => fencedHooks.push("sec") });
    let kmsCalls = 0;
    const kms = gatedKmsClient({ getPublicKey: async () => Buffer.alloc(0), signDigest: async () => { kmsCalls += 1; return Buffer.alloc(0); } }, { gate: () => writer.beforeSideEffect(), now: () => Date.now(), warn: () => undefined });
    const digest = { codec: "juno-settle/v1", purpose: "settle", hex: "ab".repeat(32) } as const;
    const event = (id: string): SecurityEvent => ({ format: "gs-security-event", version: 1, event_id: id.repeat(32).slice(0, 32), at: 5, principal_id: "pr_" + "a".repeat(25) + "0", kind: "family-revoked", family_ids: ["sf_" + "b".repeat(25) + "0"], reason: "logout" });
    try {
      /* Before: the old generation's writes land. */
      assert.equal((await ledger.reserveSettlement({ instance: "i1", seq: "1", signer_key_id: 1, digest } as never)).kind, "reserved");
      await journal.append(event("1"));
      assert.equal((await writer.check()).kind, "current");

      assert.equal((await adopt(w)).kind, "committed");

      /* The self-check proves the loss, once; the side-effect gate refuses; KMS is not called. */
      const verdict = await writer.check();
      assert.equal(verdict.kind, "lost");
      assert.match((verdict as { reason: string }).reason, /adopted app generation moved: the adopted generation is 2, not this task's 1/);
      assert.equal((await writer.check()).kind, "lost");
      assert.equal(losses.length, 1, "onLost exactly once (the runtime's exit 3)");
      await assert.rejects(kms.client.signDigest("arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111", new Uint8Array(32)), (error: unknown) => error instanceof SignerError && error.code === "unavailable");
      assert.equal(kmsCalls, 0, "nothing was sent to KMS");
      /* The ledger refuses every write of the old generation, inside the write. */
      await assert.rejects(ledger.reserveSettlement({ instance: "i1", seq: "2", signer_key_id: 1, digest } as never), (error: unknown) => error instanceof SigningJournalError && error.outcome === "fenced");
      await assert.rejects(ledger.recordAttempt({ intent_id: "cd".repeat(32), tx_id: "EF".repeat(32), account: "juno1relayer0", account_sequence: "7" } as never), (error: unknown) => error instanceof SigningJournalError && error.outcome === "fenced");
      await assert.rejects(journal.append(event("2")), StoreDefiniteError);
      assert.ok(fencedHooks.includes("generation") && fencedHooks.includes("sec"), "each reported its fence");
      assert.equal(await get(w.ledger, securityEventKey(event("2"))), null, "the SEC# event was not written");
      /* Nothing adopts what it read: the ledger instance still holds generation 1, the probe still compares 1. */
      assert.equal(ledger.generation, 1);
      assert.deepEqual(await generationProbe(client, w.ledger, 1).check(), { held: false, detail: "the adopted generation is 2, not this task's 1" });
      /* A task explicitly configured for the old generation cannot open the ledger; the new one can. */
      await assert.rejects(openDynamoSigningLedger(client, { table: w.ledger, generation: 1 }), (error: unknown) => error instanceof SigningJournalError && error.outcome === "fenced");
      assert.equal((await openDynamoSigningLedger(client, { table: w.ledger, generation: 2 })).generation, 2);
    } finally {
      writer.stop();
      client.destroy();
    }
  });

  test("the runtime: the old task exits 3 on its own self-check; a restart for the old generation, or for the new one on the OLD table, is refused before the pool; only the new generation on its prepared table starts", async () => {
    const w = await genWorld("c2");
    const identity = await tables.create("c2-identity");
    const exits: number[] = [];
    const clients: DynamoDBClient[] = [];
    const start = starter(w.ledger, identity, clients);
    const old = await start("t-old", 1, w.g1, exits);
    try {
      assert.equal(old.role, "primary");
      assert.equal((await adopt(w)).kind, "committed");
      for (let wait = 0; exits.length === 0 && wait < 400; wait += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(exits, [3], "the old task's own self-check proves the loss: exit 3, never a graceful drain");
      await assert.rejects(start("t-again", 1, w.g1), (error: unknown) => error instanceof AwsStartupError && error.exitCode === 2 && /adopted app generation is 2, not this task's 1/.test(error.message));
      await assert.rejects(start("t-mixed", 2, w.g1), (error: unknown) => error instanceof AwsStartupError && error.exitCode === 2 && /holds app generation 1, not this task's 2/.test(error.message));
      assert.deepEqual((await get(w.g1, poolKey("p1")))?.writer_task, S("t-old"), "the refused starts fenced nobody");
      const fresh = await start("t-new", 2, w.g2);
      try {
        assert.equal(fresh.role, "primary", "the new generation on its prepared table starts");
        assert.deepEqual((await get(w.g2, poolKey("p1")))?.writer_task, S("t-new"));
      } finally {
        await fresh.shutdown();
      }
    } finally {
      await old.server?.close().catch(() => undefined);
      for (const client of clients) client.destroy();
    }
  });
});

/* ==================================================================
    §F GENERATIONS N AND N+1 SIDE BY SIDE (the L5-8 addendum): the order, the old one preserved, an interrupted adoption
   ================================================================== */
describe("§F g<N> and g<N+1> coexist; the adoption order; the old generation preserved; nothing serves a generation not fully adopted", () => {
  test("two copies prepared as the SAME generation: only the one APPGEN adopted serves it; the other is refused before its pool, and the old bootstrap table too", async () => {
    const w = await genWorld("f2");
    const identity = await tables.create("f2-identity");
    const twin = await restoreCopy(w.g1, "f2-g2b");
    assert.equal((await prepareRestoredTable(admin, twin, { ...w.prepare, gameTable: twin, restoreId: "r-f2-twin" })).kind, "prepared");
    assert.equal((await adopt(w)).kind, "committed");
    const clients: DynamoDBClient[] = [];
    const start = starter(w.ledger, identity, clients);
    try {
      await assert.rejects(start("t-twin", 2, twin), (error: unknown) => error instanceof AwsStartupError && error.exitCode === 2 && /only the adopted copy of a generation serves it/.test(error.message));
      assert.equal(await get(twin, poolKey("p1")), null, "the twin's pool was never taken");
      const adopted = await start("t-adopted", 2, w.g2);
      try {
        assert.equal(adopted.role, "primary");
      } finally {
        await adopted.shutdown();
      }
    } finally {
      for (const client of clients) client.destroy();
    }
  });

  test("prepared but NOT adopted (an interrupted adoption: no answer, nothing landed): the new generation refuses to serve, the old one still serves; the re-run adopts exactly once; then only the new one serves -- and g<N> is never touched", async () => {
    const w = await genWorld("f1", { prepare: false });
    const identity = await tables.create("f1-identity");
    const clients: DynamoDBClient[] = [];
    const start = starter(w.ledger, identity, clients);
    try {
      /* 1. The restored table exists beside the old one, unprepared: it carries the SOURCE's marker (generation 1 of g1). */
      const g1Before = await scanAll(w.g1);
      await assert.rejects(start("t-early", 2, w.g2), (error: unknown) => error instanceof AwsStartupError && error.exitCode === 2 && /adopted app generation is 1, not this task's 2/.test(error.message));
      await assert.rejects(start("t-copy", 1, w.g2), (error: unknown) => error instanceof AwsStartupError && /names the table .*-f1-g1, not this task's .*-f1-g2/.test(error.message), "an unprepared copy never serves as the old generation either");
      /* 2. The adoption refuses an unprepared target (the order: prepare, THEN adopt). */
      assert.equal((await adopt(w)).kind, "refused");
      /* 3. Prepared: SYSTEM/GENERATION of g2 says 2 (restored from 1 of g1); APPGEN still 1 -- not adopted: g2 serves nothing. */
      assert.equal((await prepareRestoredTable(admin, w.g2, w.prepare)).kind, "prepared");
      await assert.rejects(start("t-prepared", 2, w.g2), (error: unknown) => error instanceof AwsStartupError && error.exitCode === 2 && /adopted app generation is 1, not this task's 2/.test(error.message));
      /* 4. An adoption interrupted (no answer, nothing landed): unknown; APPGEN untouched; still nothing serves g2, and the
            old generation still starts (nothing about g1 moved). */
      assert.equal((await adopt(w, w.request, faulty("drop"))).kind, "unknown");
      await assert.rejects(start("t-half", 2, w.g2), (error: unknown) => error instanceof AwsStartupError && /adopted app generation is 1/.test(error.message));
      const oldExits: number[] = [];
      const old = await start("t-old", 1, w.g1, oldExits);
      assert.equal(old.role, "primary");
      /* 5. The re-run adopts once; the old task is fenced (exit 3); a second re-run writes nothing. */
      assert.equal((await adopt(w)).kind, "committed");
      for (let wait = 0; oldExits.length === 0 && wait < 400; wait += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(oldExits, [3]);
      await old.server?.close().catch(() => undefined);
      assert.equal((await adopt(w)).kind, "already-adopted");
      /* 6. Only the new generation, explicitly configured, on its prepared table serves. */
      const g1AfterOld = await scanAll(w.g1);
      await assert.rejects(start("t-back", 1, w.g1), (error: unknown) => error instanceof AwsStartupError && /adopted app generation is 2/.test(error.message));
      const fresh = await start("t-new", 2, w.g2);
      try {
        assert.equal(fresh.role, "primary");
      } finally {
        await fresh.shutdown();
      }
      /* 7. The old generation is PRESERVED: its marker still says generation 1 of g1 (bootstrap), nothing of the adoption,
            the preparation or the new task wrote to it; the refused start wrote nothing either. */
      assert.equal(sortedJson(await scanAll(w.g1)), sortedJson(g1AfterOld), "nothing touched g1 after the old task stopped");
      const g1Marker = await readGenerationMarker(admin, w.g1);
      assert.deepEqual({ generation: g1Marker?.generation, origin: g1Marker?.origin, table: g1Marker?.game_table }, { generation: 1, origin: "bootstrap", table: w.g1 });
      const untouched = (items: Item[]) => items.filter((item) => !(item.pk?.S ?? "").startsWith("POOL#") && !(item.pk?.S ?? "").startsWith("ROLE#") && !(item.pk?.S ?? "").startsWith("TASK#"));
      assert.equal(sortedJson(untouched(g1AfterOld)), sortedJson(untouched(g1Before)), "beyond its own task's pool item, g1 holds exactly what it held before the restore began");
    } finally {
      for (const client of clients) client.destroy();
    }
  });
});

/* ==================================================================
    §D THE IDENTITY RESTORE
   ================================================================== */
const readOf = (setCookie: string | null | undefined): SessionCookieRead => readSessionCookie((setCookie as string).split(";")[0]);
const sessionIdOf = (read: SessionCookieRead): string => (read.kind === "session" ? read.sessionId : "");
/** Cheap scrypt parameters for the test writer (a stored hash carries its own). */
const POLICY = { passwordKdf: { logN: 10, r: 1, p: 1 } };
/** A legacy recovery key's digest (hex SHA-256), as an earlier build stored it. */
const keyDigest = (key: string): string => createHash("sha256").update(key).digest("hex");

/** PHASE 3 FINAL: an account of this build (username, password, Authorization Wallet). */
interface Account {
  read: SessionCookieRead;
  username: string;
  /** Every password it had, oldest first: the last is the account's. */
  passwords: string[];
  principalId: string;
}

async function identityWorld(label: string) {
  const ledger = await tables.create(`${label}-ledger`);
  await put(ledger, { ...LEDGER_KEYS.appgen(), schema: N(1), current_generation: N(1) });
  const source = await tables.create(`${label}-identity`);
  /* The live table was taken as a serving task takes it: it NAMES ITSELF (TABLE#identity) from then on. */
  const { epoch } = await takeOverIdentityWriter(admin, source, { task: "t-live", pool: "p1", now: () => 1, checks: identityServingChecks(source) });
  let clock = 1_780_000_000_000;
  const now = () => clock;
  const store = createDynamoIdentityStore(admin, source, { epoch, sleep: noSleep });
  const journal = createDynamoSecurityJournal(admin, ledger, { generation: 1, sleep: noSleep });
  const identity = await IdentityService.open(store, { policy: POLICY, security: { journal, grants: store.grants, clock: now } });
  const create = async (name: string): Promise<Account> => {
    clock += 60_000;
    const boot = await identity.bootstrap({ kind: "none" }, false, now());
    const username = name.toLowerCase();
    const password = `${username} password 0`;
    const created = await createAccountWith(identity, readOf((boot as { setCookie: string | null }).setCookie), { username, password, displayName: name, wallet: keplrAccount(`l6-4-dynamo/${label}/${username}`) }, now());
    assert.equal(created.kind, "ok");
    await identity.settled();
    const read = readOf((created as { setCookie: string }).setCookie);
    return { read, username, passwords: [password], principalId: (identity.peekSession(sessionIdOf(read)) as Session).principal_id };
  };
  /** "Change password" on the account's browser (which goes on with a fresh cookie; every other device is signed out). */
  const change = async (who: Account) => {
    clock += 60_000;
    const next = `${who.username} password ${who.passwords.length}`;
    const changed = await identity.changePassword(who.read, { currentPassword: who.passwords[who.passwords.length - 1], newPassword: next }, now());
    assert.equal(changed.kind, "ok");
    await identity.settled();
    who.passwords.push(next);
    who.read = readOf((changed as { setCookie: string }).setCookie);
  };
  /* A LEGACY profile (schema 1: a recovery-key profile an EARLIER build made), its records written through the same
     store and its events into the same journal exactly as that build wrote them. This build makes none and serves none
     (retired), but the restore still replays what that build journaled -- an unconfirmed key rotation is the one change
     that sends a profile to operator review. */
  let legacyEvents = 0;
  type ConfirmationDraft = Omit<Extract<SecurityEvent, { kind: "confirmed" }>, "format" | "version" | "event_id">;
  const legacyEvent = (draft: SecurityEventDraft | ConfirmationDraft): SecurityEvent =>
    ({ format: SECURITY_EVENT_FORMAT, version: SECURITY_EVENT_VERSION, event_id: `ee${(legacyEvents += 1).toString(16).padStart(6, "0")}${"0".repeat(24)}`, ...draft }) as SecurityEvent;
  const legacy = async (name: string) => {
    clock += 60_000;
    const at = now();
    const [principalId, profileId, sessionId, secret, key] = [mintPrincipalId(), mintProfileId(), mintSessionId(), mintSecret(), mintRecoveryKey()];
    const familyId = familyIdOf(sessionId);
    const principal: Principal = { principal_id: principalId, kind: "profile", status: "active", created_at: at, activated_at: at, last_seen_at: at, account_link: profileId };
    const profile: Profile = { profile_id: profileId, principal_id: principalId, display_name: name, created_at: at, status: "active", recovery_selector: key.selector, recovery_hash: keyDigest(key.key), recovery_rotated_at: at, schema: 1 };
    const session: Session = { session_id: sessionId, principal_id: principalId, secret_hash: secretHash(secret), created_at: at, last_seen_at: at, expires_at: at + 30 * 24 * 3_600_000, revoked_at: null, revoke_reason: null, rotated_to: null, family_id: familyId };
    const family: SessionFamily = { family_id: familyId, principal_id: principalId, created_at: at, origin: "bootstrap", revoked_at: null, revoke_reason: null };
    const creation = legacyEvent({ kind: "profile-created", at, principal_id: principalId, principal, profile });
    await journal.append(creation);
    await store.commit({
      expect: [
        { kind: "principal-absent", principal_id: principalId },
        { kind: "profile-absent", profile_id: profileId },
        { kind: "selector-unused", recovery_selector: key.selector },
        { kind: "session-absent", session_id: sessionId },
        { kind: "family-absent", family_id: familyId },
      ],
      principals: [principal],
      profiles: [profile],
      sessions: [session],
      families: [family],
    });
    await journal.append(legacyEvent({ kind: "confirmed", at, principal_id: principalId, confirms: creation.event_id, confirmed_kind: "profile-created" }));
    return { read: { kind: "session", sessionId, secret } as SessionCookieRead, principalId, profile, keys: [key.selector] };
  };
  /** The legacy key rotation: its event, then its change -- and its confirmation LOST (never written). */
  const rotateUnconfirmed = async (who: Awaited<ReturnType<typeof legacy>>) => {
    clock += 60_000;
    const at = now();
    const next = mintRecoveryKey();
    const event = legacyEvent({ kind: "recovery-key-rotated", at, principal_id: who.principalId, profile_id: who.profile.profile_id, from_selector: who.keys[0], to_selector: next.selector, recovery_hash: keyDigest(next.key), rotated_at: at });
    await journal.append(event);
    await store.commit({
      expect: [{ kind: "profile-selector", profile_id: who.profile.profile_id, recovery_selector: who.keys[0] }, { kind: "selector-unused", recovery_selector: next.selector }],
      profiles: [{ ...who.profile, recovery_selector: next.selector, recovery_hash: keyDigest(next.key), recovery_rotated_at: at }],
    });
    who.keys.push(next.selector);
    return event;
  };
  const ann = await create("Ann");
  clock += 60_000;
  /* Ann's phone: a sign-in with her username and password (its own family). */
  const phoneBoot = await identity.bootstrap({ kind: "none" }, false, now());
  const phone = await identity.login(readOf((phoneBoot as { setCookie: string | null }).setCookie), { username: ann.username, password: ann.passwords[0] }, now());
  assert.equal(phone.kind, "ok");
  const dave = await legacy("Dave");
  const carol = await create("Carol");
  /* THE RESTORE POINT: the table as it stands now. */
  const restorePoint = clock;
  const restored = await restoreCopy(source, `${label}-restored`);
  clock += 20 * 60_000; // the serving table goes on: its later records are past the restore point's allowance

  assert.equal((await identity.reauthenticateWithPassword(ann.read, ann.passwords[0], now())).kind, "ok");
  assert.equal((await identity.signOutOthers(ann.read, now())).kind, "ok");
  await change(ann);
  const bob = await create("Bob");
  /* Dave's (legacy) rotation committed; its confirmation is lost. */
  const daveRotation = await rotateUnconfirmed(dave);
  clock += 60_000;
  assert.equal(await identity.disablePrincipal(carol.principalId, now()), true);
  await identity.settled();
  const request: IdentityRestoreRequest = { table: restored, restoreId: `r-${label}`, restorePoint, source: { kind: "fence", table: source }, by: "op-drill" };
  return { ledger, source, restored, request, ann, dave, carol, bob, phone: readOf((phone as { setCookie: string }).setCookie), daveRotation, now: () => clock + 3_600_000 };
}

/** A sign-in on a new browser: what a password opens. */
async function loginWith(identity: IdentityService, username: string, password: string, now: number): Promise<string> {
  const boot = await identity.bootstrap({ kind: "none" }, false, now);
  return (await identity.login(readOf((boot as { setCookie: string | null }).setCookie), { username, password }, now)).kind;
}

describe("§D the identity restore on DynamoDB", () => {
  test("dry run writes nothing; an interrupted replay leaves the table UNSERVED (load and serving takeover refused); the resumed replay completes; the restored identity keeps every security action and signs every session out; a re-run writes nothing", async () => {
    const w = await identityWorld("d1");
    const deps = { client: admin, ledger: { client: admin, table: w.ledger }, now: w.now, sleep: noSleep };
    const restoredBefore = await scanAll(w.restored);
    const sourceRole = await readIdentityRole(admin, w.source);
    /* A fresh copy, before its replay has begun, serves NOTHING: it carries its source's name. */
    await assert.rejects(createDynamoIdentityStore(admin, w.restored, { epoch: sourceRole!.epoch }).load(), (error: unknown) => error instanceof IdentityRestoreIncompleteError && /names itself .*-d1-identity/.test((error as Error).message));
    await assert.rejects(takeOverIdentityWriter(admin, w.restored, { task: "t-early", pool: "p1", now: () => 1, checks: identityServingChecks(w.restored), maxAttempts: 1 }), IdentityRoleRefusedError);
    const plan = await planIdentityRestore(deps, w.request);
    assert.equal(plan.kind, "planned");
    assert.equal(sortedJson(await scanAll(w.restored)), sortedJson(restoredBefore), "the dry run wrote nothing to the restored table");
    assert.deepEqual(await readIdentityRole(admin, w.source), sourceRole, "... nor fenced the source");
    assert.equal(plan.report.plan?.reviews, 1);
    assert.ok((plan.report.plan?.sessions_signed_out ?? 0) >= 3);

    /* Interrupted after one principal: the marker is replaying -- nothing may serve the table. */
    const interrupted = await applyIdentityRestore({ ...deps, stopAfter: 1 }, w.request);
    assert.equal(interrupted.kind, "incomplete");
    assert.equal(interrupted.report.source.state, "fenced");
    assert.ok((await readIdentityRole(admin, w.source))!.epoch > sourceRole!.epoch, "the source's identity writer was fenced");
    const status = await inspectIdentityRestore(admin, w.restored);
    assert.equal(status.marker?.state, "replaying");
    assert.equal(status.serving, false);
    const serving = createDynamoIdentityStore(admin, w.restored, { epoch: status.role_epoch ?? 1 });
    await assert.rejects(serving.load(), IdentityRestoreIncompleteError);
    await assert.rejects(takeOverIdentityWriter(admin, w.restored, { task: "t-serving", pool: "p1", now: () => 1, checks: identityServingChecks(w.restored), maxAttempts: 1 }), IdentityRoleRefusedError);
    /* The serving path end to end (L5-3's takeover with the routing and pool conditions): refused, with the reason. */
    const game = await tables.create("d1-game");
    assert.equal((await setPrimaryPool(admin, game, { pool: "p1", expectedVersion: null, by: "pipeline", now: 1 })).kind, "set");
    const writer = await PoolWriter.take({ client: admin, table: game, pool: "p1", task: "t-serving", now: () => Date.now(), onLost: () => undefined });
    await assert.rejects(takeIdentityWriterRole(writer, { client: admin, table: w.restored }, { now: () => 1, maxAttempts: 1, sleep: noSleep }), (error: unknown) => error instanceof IdentityRestoreIncompleteError && /has not completed/.test((error as Error).message));
    assert.equal((await readIdentityRole(admin, w.restored))?.epoch, status.role_epoch, "the replay was not fenced by the serving task");

    /* Resumed: completes. */
    const done = await applyIdentityRestore(deps, w.request);
    assert.equal(done.kind, "complete", "detail" in done ? done.detail : "");
    const final = await inspectIdentityRestore(admin, w.restored);
    assert.equal(final.marker?.state, "complete");
    assert.equal(final.serving, true);
    assert.equal(final.reviews.length, 1);
    assert.equal(final.reviews[0].principal_id, w.dave.principalId);
    assert.deepEqual(JSON.parse(final.reviews[0].unconfirmed_events), [w.daveRotation.event_id]);

    /* A re-run of a completed restore writes NOTHING (the table may be serving). */
    const settled = await scanAll(w.restored);
    const sourceAfter = await readIdentityRole(admin, w.source);
    assert.equal((await applyIdentityRestore(deps, w.request)).kind, "already-complete");
    assert.equal(sortedJson(await scanAll(w.restored)), sortedJson(settled));
    assert.deepEqual(await readIdentityRole(admin, w.source), sourceAfter);

    /* The SOURCE is superseded for good: a serving task restarted with the old runtime document cannot take it back. */
    assert.equal((await inspectIdentityRestore(admin, w.source)).marker?.state, "superseded");
    const oldGame = await tables.create("d1-old-game");
    assert.equal((await setPrimaryPool(admin, oldGame, { pool: "p1", expectedVersion: null, by: "pipeline", now: 1 })).kind, "set");
    const oldWriter = await PoolWriter.take({ client: admin, table: oldGame, pool: "p1", task: "t-old-again", now: () => Date.now(), onLost: () => undefined });
    await assert.rejects(takeIdentityWriterRole(oldWriter, { client: admin, table: w.source }, { now: () => 1, maxAttempts: 1, sleep: noSleep }), (error: unknown) => error instanceof IdentityRestoreIncompleteError && /superseded/.test((error as Error).message));
    await assert.rejects(createDynamoIdentityStore(admin, w.source, { epoch: (await readIdentityRole(admin, w.source))!.epoch }).load(), IdentityRestoreIncompleteError);
    /* A COPY of the completed table carries its marker (naming the original): it serves nothing and is not "already complete". */
    const copy = await restoreCopy(w.restored, "d1-copy");
    assert.equal((await inspectIdentityRestore(admin, copy)).serving, false);
    await assert.rejects(createDynamoIdentityStore(admin, copy, { epoch: 1 }).load(), (error: unknown) => error instanceof IdentityRestoreIncompleteError && /another table's restore marker|names itself/.test((error as Error).message));
    await assert.rejects(takeOverIdentityWriter(admin, copy, { task: "t-copy", pool: "p1", now: () => 1, checks: identityServingChecks(copy), maxAttempts: 1 }), IdentityRoleRefusedError);
    assert.notEqual((await planIdentityRestore(deps, { ...w.request, table: copy })).kind, "already-complete");

    /* The restored identity, served: every old session out; every security action kept; the chain; the review. */
    const { epoch } = await takeOverIdentityWriter(admin, w.restored, { task: "t-new", pool: "p1", now: () => 2, checks: identityServingChecks(w.restored) });
    const identity = await IdentityService.open(createDynamoIdentityStore(admin, w.restored, { epoch, sleep: noSleep }), { policy: POLICY });
    const later = w.now();
    for (const read of [w.ann.read, w.phone, w.dave.read, w.carol.read]) assert.notEqual(identity.authenticate(read, later).kind, "ok", "signed out");
    assert.equal(await loginWith(identity, w.ann.username, w.ann.passwords[1], later), "ok", "Ann's changed password (the journal's chain)");
    assert.equal(await loginWith(identity, w.ann.username, w.ann.passwords[0], later), "invalid", "Ann's retired password never comes back");
    assert.equal(await loginWith(identity, w.bob.username, w.bob.passwords[0], later), "ok", "Bob, created after the restore point");
    assert.equal(await loginWith(identity, w.carol.username, w.carol.passwords[0], later), "invalid", "Carol stays disabled");
    /* Dave (legacy) is under review: disabled, neither key his -- the quarantine key nobody holds. */
    const dave = identity.peekProfileOf(w.dave.principalId);
    assert.equal(dave?.status, "disabled");
    assert.ok(dave !== undefined && !w.dave.keys.includes(dave.recovery_selector), "Dave is under review: neither key");
  });

  test("the dry run refuses what apply refuses (a fenced source that does not exist); a resumed replay keeps its source", async () => {
    const w = await identityWorld("d4");
    const deps = { client: admin, ledger: { client: admin, table: w.ledger }, now: w.now, sleep: noSleep };
    const missing: IdentityRestoreRequest = { ...w.request, source: { kind: "fence", table: "gs-l64-no-such-table" } };
    assert.equal((await planIdentityRestore(deps, missing)).kind, "refused");
    assert.equal((await applyIdentityRestore(deps, missing)).kind, "refused");
    assert.equal((await applyIdentityRestore({ ...deps, stopAfter: 0 }, w.request)).kind, "incomplete");
    const other = await tables.create("d4-other");
    const switched = await applyIdentityRestore(deps, { ...w.request, source: { kind: "fence", table: other } });
    assert.equal(switched.kind, "refused");
    assert.match((switched as { detail: string }).detail, /keeps its source/);
    assert.equal((await applyIdentityRestore(deps, w.request)).kind, "complete");
  });

  test("the wrong table -- the serving one, or a copy made later -- is refused before anything is written (it holds records created after the restore point)", async () => {
    const w = await identityWorld("d0");
    const deps = { client: admin, ledger: { client: admin, table: w.ledger }, now: w.now, sleep: noSleep };
    const sourceRole = await readIdentityRole(admin, w.source);
    const swapped: IdentityRestoreRequest = { ...w.request, table: w.source, source: { kind: "fence", table: w.restored } };
    for (const run of [planIdentityRestore, applyIdentityRestore]) {
      const answer = await run(deps, swapped);
      assert.equal(answer.kind, "refused");
      assert.match((answer as { detail: string }).detail, /after the restore point/);
    }
    assert.deepEqual(await readIdentityRole(admin, w.source), sourceRole, "the serving table's writer was not fenced");
    assert.equal((await inspectIdentityRestore(admin, w.source)).marker, null);
  });

  test("a journal that CHANGES during the replay (a writer still appending) leaves the table unserved; a malformed journal is refused before the table is touched", async () => {
    const w = await identityWorld("d2");
    let scans = 0;
    const appended = { done: false };
    const racing = {
      send: async (command: unknown, extra?: unknown) => {
        if (command instanceof ScanCommand && (command.input.FilterExpression ?? "").includes("begins_with")) {
          scans += 1;
          if (scans === 3 && !appended.done) { // the pre-plan (1), the run's journal (2), the verification (3)
            appended.done = true;
            const straggler: SecurityEvent = { format: "gs-security-event", version: 1, event_id: "9".repeat(32), at: 7, principal_id: w.ann.principalId, kind: "family-revoked", family_ids: ["sf_" + "c".repeat(25) + "0"], reason: "logout" };
            await createDynamoSecurityJournal(admin, w.ledger, { generation: 1, sleep: noSleep }).append(straggler);
          }
        }
        return admin.send(command as never, extra as never);
      },
    } as unknown as DynamoDBClient;
    const deps = { client: admin, ledger: { client: racing, table: w.ledger }, now: w.now, sleep: noSleep, scanSegments: 1 };
    const raced = await applyIdentityRestore(deps, w.request);
    assert.equal(raced.kind, "incomplete");
    assert.match((raced as { detail: string }).detail, /journal CHANGED/);
    assert.equal((await inspectIdentityRestore(admin, w.restored)).serving, false, "unserved");
    assert.equal((await applyIdentityRestore({ ...deps, ledger: { client: admin, table: w.ledger } }, w.request)).kind, "complete", "a re-run replays the journal as it now stands");

    const bad = await identityWorld("d3");
    const badSourceRole = await readIdentityRole(admin, bad.source);
    await put(bad.ledger, { pk: S(`SEC#${bad.ann.principalId}`), sk: S("0000000000001#" + "1".repeat(32)), fmt: N(1), kind: S("family-revoked"), at: N(1), event_id: S("1".repeat(32)), body: S("{not an event}") });
    const before = await scanAll(bad.restored);
    const refused = await applyIdentityRestore({ client: admin, ledger: { client: admin, table: bad.ledger }, now: bad.now, sleep: noSleep }, bad.request);
    assert.equal(refused.kind, "refused");
    const after = (await scanAll(bad.restored)).filter((item) => item.pk?.S !== "ROLE#identity-writer");
    assert.equal(sortedJson(after), sortedJson(before.filter((item) => item.pk?.S !== "ROLE#identity-writer")), "no marker, no change");
    assert.deepEqual(await get(bad.restored, { pk: S("ROLE#identity-writer"), sk: S("ROLE") }), before.find((item) => item.pk?.S === "ROLE#identity-writer") ?? null, "not even a role was taken");
    assert.equal((await planIdentityRestore({ client: admin, ledger: { client: admin, table: bad.ledger }, now: bad.now }, bad.request)).kind, "refused");
    /* A CONTRADICTORY journal (well-formed items: a confirmation of an event nobody wrote) is refused just as early. */
    const odd = await identityWorld("d3b");
    const oddSourceRole = await readIdentityRole(admin, odd.source);
    await createDynamoSecurityJournal(admin, odd.ledger, { generation: 1, sleep: noSleep }).append({ format: "gs-security-event", version: 1, event_id: "e".repeat(32), at: 9, principal_id: odd.ann.principalId, kind: "confirmed", confirms: "d".repeat(32), confirmed_kind: "family-revoked" });
    const contradicted = await applyIdentityRestore({ client: admin, ledger: { client: admin, table: odd.ledger }, now: odd.now, sleep: noSleep }, odd.request);
    assert.equal(contradicted.kind, "refused");
    assert.match((contradicted as { detail: string }).detail, /source was not fenced/);
    assert.deepEqual(await readIdentityRole(admin, odd.source), oddSourceRole);
    assert.equal((await inspectIdentityRestore(admin, odd.source)).serving, true);
    /* The refusal came BEFORE any write to the source: not fenced, not superseded -- it still serves. */
    assert.deepEqual(await readIdentityRole(admin, bad.source), badSourceRole);
    assert.equal((await inspectIdentityRestore(admin, bad.source)).serving, true);
  });
});

/* ==================================================================
    §E THE OPERATOR COMMANDS
   ================================================================== */
describe("§E the operator commands: plan by default, no secret in any answer", () => {
  test("table-prepare, appgen-adopt and identity-replay plan unless --apply (the adoption also needs --stopped); every answer is printable", async () => {
    const w = await genWorld("e1", { prepare: false });
    const clientsFor = () => ({ app: admin, ledger: { client: admin, table: w.ledger } });
    const run = async (argv: string[]) => {
      const result = await runRecoveryCommand(argv, clientsFor, () => 5_000);
      assertPrintable(JSON.stringify(result.answer));
      return result;
    };
    const prep = ["table-prepare", "--game-table", w.g2, "--generation", "2", "--from-generation", "1", "--from-table", w.g1, "--restore-point", "1000", "--restore-id", w.prepare.restoreId, "--by", "op-drill"];
    const planned = await run(prep);
    assert.deepEqual([planned.exitCode, (planned.answer as { kind: string; dry_run: boolean }).kind, (planned.answer as { dry_run: boolean }).dry_run], [0, "ready", true]);
    assert.equal((await readGenerationMarker(admin, w.g2))?.generation, 1, "planned only");
    assert.equal((await run([...prep, "--apply"])).exitCode, 0);
    const adoptArgs = ["appgen-adopt", "--ledger", w.ledger, "--expected", "1", "--generation", "2", "--game-table", w.g2, "--restore-id", w.prepare.restoreId, "--by", "op-drill"];
    assert.equal(((await run(adoptArgs)).answer as { kind: string }).kind, "ready");
    const unattested = await run([...adoptArgs, "--apply"]);
    assert.deepEqual([unattested.exitCode, (unattested.answer as { kind: string }).kind], [1, "refused"]);
    assert.equal((await readAppGeneration(admin, w.ledger))?.current_generation, 1);
    const applied = await run([...adoptArgs, "--apply", "--stopped"]);
    assert.deepEqual([applied.exitCode, (applied.answer as { kind: string }).kind], [0, "committed"]);
    assert.equal(((await run(["appgen-status", "--ledger", w.ledger])).answer as { adoptions: unknown[] }).adoptions.length, 1);

    const id = await identityWorld("e2");
    const idClients = () => ({ app: admin, ledger: { client: admin, table: id.ledger } });
    const replayArgs = ["identity-replay", "--identity-table", id.restored, "--ledger", id.ledger, "--restore-id", id.request.restoreId, "--restore-point", String(id.request.restorePoint), "--by", "op-drill", "--source-table", id.source];
    const secrets = [...id.ann.passwords, ...id.bob.passwords, ...id.carol.passwords, ...id.dave.keys].concat([id.ann.read, id.phone, id.dave.read].flatMap((read) => (read.kind === "session" ? [read.sessionId, read.secret] : [])));
    for (const argv of [replayArgs, [...replayArgs, "--apply"], ["identity-status", "--identity-table", id.restored]]) {
      const result = await runRecoveryCommand(argv, idClients, id.now);
      const text = assertPrintable(JSON.stringify(result.answer));
      for (const secret of secrets) assert.ok(!text.includes(secret), "no password, key selector, session id or secret");
      assert.equal(result.exitCode, 0, text.slice(0, 400));
    }
    await assert.rejects(runRecoveryCommand(["identity-replay", "--identity-table", id.restored], idClients), /--source-table|required/);
  });
});
