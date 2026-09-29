// server/src/persistence/conformance/dynamoLedger.conformance.test.ts
//
// ==================================================================
//  LIVE-5 L5-5: THE SIGNING LEDGER ON DYNAMODB LOCAL -- JOURNAL_CASES, THEN WHAT ONLY A LEDGER HAS
// ==================================================================
//
// Runs ONLY against a DynamoDB Local named by GS_DYNAMODB_LOCAL_ENDPOINT (`npm run test:dynamodb-local`; see
// server/src/aws/README.md). Not part of `npm test`; without the variable it FAILS with instructions.
//
//   1. JOURNAL_CASES -- the same cases the memory and file journals run -- against `openDynamoSigningLedger`: the fence
//      inside the write for reservations (JNL-12) and attempts (JNL-16), the idempotent resend with the same token, the
//      landed / unlanded outcomes around a takeover, damage and newer records failing closed, racing writers.
//   2. What the port cannot express, because only the ledger has it: two INDEPENDENT fences (the app generation, the
//      relayer epoch), the relayer takeover (minting the epoch), a stale writer never answered `same`, a reused token, a
//      transaction id recorded with other facts, a write that lands only AFTER its writer gave up, the exact items.
//   3. The ledger with the settlement signer: a KMS answer lost after the signature was made never lets a second digest
//      be signed at the slot.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { GetItemCommand, ListTablesCommand, PutItemCommand, ScanCommand, type AttributeValue, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { createDynamoDbClient, deadline, dynamoLocalTargetFromEnv, DYNAMODB_LOCAL_ENV } from "../../aws/awsClients";
import { LEDGER_KEYS, LedgerUnreadableError, openDynamoSigningLedger, type DynamoSigningLedger, type DynamoSigningLedgerOptions } from "../../aws/ledger/dynamoSigningLedger";
import { SigningJournalError } from "../../escrow/signingJournal";
import { SignerError, type DigestSigner } from "../../escrow/juno/signer";
import { escrowInstanceKey } from "../../../../frontend/src/gameEngine/escrow/escrowModel";
import { createSettlementCoordinator } from "../../escrow/settlementCoordinator";
import { serverPrefixReplay, type PrefixReplay } from "../../escrow/settlementEvidence";
import { sealOf } from "../../rooms/lifecycle";
import { ALICE, BUILD, PASS, quietConsole } from "../../rooms/testSupport";
import type { GameStateResponse } from "../../../../frontend/src/gameEngine/gameState";
import { GAME_A, makeWorld, move, play, RELAYER_ADDRESS, startedGame, toStockRound, type World } from "../../escrow/escrow3bSupport";
import { arrive, gate, type Gate } from "./faults";
import { ConformanceTables, installFaults, newRunId, requireLocal } from "./dynamoLocal";
import { runConformance, runCase, type CaseContext } from "./harness";
import { JOURNAL_CASES, type JournalPlant, type JournalSubject } from "./identityJournal.conformance";

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
const RELAYER = "juno1relayer";
const RESENDS = 3;
const S = (value: string): AttributeValue => ({ S: value });
const N = (value: number | string): AttributeValue => ({ N: String(value) });
const TWI = "TransactWriteItemsCommand";

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
/* One table per case, its fences, and a client carrying the case's faults */
/* ------------------------------------------------------------------ */

interface LedgerTable {
  readonly table: string;
  readonly client: DynamoDBClient;
}
const perCase = new WeakMap<CaseContext, LedgerTable>();

const put = (table: string, item: Record<string, AttributeValue>) => admin.send(new PutItemCommand({ TableName: table, Item: item }), { abortSignal: deadline() });
const appgenItem = (generation: number, schema = 1) => ({ ...LEDGER_KEYS.appgen(), schema: N(schema), current_generation: N(generation) });
/** The token a harness-minted fence carries (unique per run: tokens name who minted an epoch). */
const fenceToken = (epoch: number) => `mint-${tables.runId}-${epoch}`;
const fenceItem = (epoch: number, schema = 1, relayer = RELAYER, token = fenceToken(epoch)) => ({ ...LEDGER_KEYS.fence(relayer), schema: N(schema), kind: S("relayer-fence"), relayer: S(relayer), epoch: N(epoch), at: N(0), generation: N(1), token: S(token) });
const heldAt = (epoch: number) => ({ epoch, token: fenceToken(epoch) });

/** A fresh ledger table: APPGEN at `generation`, the relayer fence at `epoch` (the case's writer epoch by default). */
async function ledgerTable(ctx: CaseContext, label = "ledger"): Promise<LedgerTable> {
  const known = perCase.get(ctx);
  if (known !== undefined) return known;
  const table = await tables.create(label);
  const client = createDynamoDbClient(TARGET);
  await requireLocal(client);
  installFaults(client, ctx.faults);
  await put(table, appgenItem(ctx.fence.epoch));
  await put(table, fenceItem(ctx.fence.epoch));
  /* The harness's fence is the writer's whole identity here: a takeover moves BOTH the adopted generation and the
     relayer epoch (the two independent moves are exercised in §2 below). */
  ctx.fence.onTakeOver(async (epoch) => {
    await put(table, appgenItem(epoch));
    await put(table, fenceItem(epoch));
  });
  ctx.defer(async () => {
    client.destroy();
    await tables.drop(table);
  });
  const entry = { table, client };
  perCase.set(ctx, entry);
  return entry;
}

async function scanAll(table: string): Promise<Array<Record<string, AttributeValue>>> {
  const out: Array<Record<string, AttributeValue>> = [];
  let start: Record<string, AttributeValue> | undefined;
  do {
    const page = await admin.send(new ScanCommand({ TableName: table, ConsistentRead: true, ExclusiveStartKey: start }), { abortSignal: deadline() });
    out.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return out;
}

const canonical = (item: Record<string, AttributeValue>) => JSON.stringify(Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
const isRecord = (item: Record<string, AttributeValue>) => item.pk?.S !== "APPGEN" && !(item.pk?.S ?? "").startsWith("FENCE#");

/** The ledger's records (not its fences), one canonical line per item, in key order. */
async function records(table: string): Promise<string | null> {
  const items = (await scanAll(table)).filter(isRecord).sort((a, b) => {
    const ka = `${a.pk?.S}\u0000${a.sk?.S}`;
    const kb = `${b.pk?.S}\u0000${b.sk?.S}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return items.length === 0 ? null : `${items.map(canonical).join("\n")}\n`;
}

async function getItem(table: string, key: { pk: AttributeValue; sk: AttributeValue }) {
  return (await admin.send(new GetItemCommand({ TableName: table, Key: key, ConsistentRead: true }), { abortSignal: deadline() })).Item ?? null;
}

async function overwrite(table: string, key: { pk: AttributeValue; sk: AttributeValue }, change: (item: Record<string, AttributeValue>) => Record<string, AttributeValue>) {
  const item = await getItem(table, key);
  assert.ok(item !== null, `${key.pk.S} / ${key.sk.S} exists to damage`);
  await put(table, change(item));
}

async function plantLedger(table: string, what: JournalPlant): Promise<void> {
  switch (what.kind) {
    case "corrupt":
      await overwrite(table, LEDGER_KEYS.settle(what.instance, what.seq, what.signer_key_id), (item) => ({ ...item, digest_hex: S("not-a-digest") }));
      return;
    case "newer":
      await overwrite(table, LEDGER_KEYS.settle(what.instance, what.seq, what.signer_key_id), (item) => ({ ...item, schema: N(2) }));
      return;
    case "corrupt-attempt":
    case "newer-attempt": {
      const change = (item: Record<string, AttributeValue>) => (what.kind === "newer-attempt" ? { ...item, schema: N(2) } : { ...item, sequence: S("01") });
      await overwrite(table, LEDGER_KEYS.txid(what.tx_id), change);
      await overwrite(table, LEDGER_KEYS.attempt(what.account, what.sequence, what.tx_id), change);
      await overwrite(table, LEDGER_KEYS.atti(what.intent_id, what.sequence, what.tx_id), change);
      return;
    }
    default:
      throw new Error(`a ledger cannot hold a ${what.kind}`);
  }
}

const zeroWait = async () => undefined;
const openFor = async (ctx: CaseContext, over: Partial<DynamoSigningLedgerOptions> = {}): Promise<DynamoSigningLedger> => {
  const { client, table } = await ledgerTable(ctx);
  return openDynamoSigningLedger(client, { table, generation: ctx.fence.epoch, relayer: { address: RELAYER, held: heldAt(ctx.fence.epoch) }, now: () => ctx.now(), sleep: zeroWait, resends: RESENDS, ...over });
};

const tokensOf = (ctx: CaseContext) => ctx.faults.calls.filter((call) => call.op === TWI).map((call) => (JSON.parse(call.detail) as { ClientRequestToken?: string }).ClientRequestToken ?? "");

const ledgerSubject: JournalSubject = {
  name: "dynamodb-local (openDynamoSigningLedger)",
  backend: "dynamodb",
  capabilities: ["durable", "fence", "fence-in-write", "plant", "stall-write", "idempotency-token", "inject-lost-answer", "inject-transient-failure", "inject-unresolved"],
  async open(ctx) {
    return openFor(ctx);
  },
  async stored(ctx) {
    return records((await ledgerTable(ctx)).table);
  },
  async plant(ctx, what) {
    await plantLedger((await ledgerTable(ctx)).table, what);
  },
  armLostAnswer(ctx) {
    ctx.faults.add({ op: TWI, action: { kind: "lose-answer" }, label: "the write lands, its answer is lost" });
  },
  armTransientFailure(ctx) {
    ctx.faults.add({ op: TWI, action: { kind: "fail" }, label: "the write is throttled" });
  },
  stallNextWrite(ctx) {
    const stall = gate();
    ctx.faults.add({ op: TWI, action: { kind: "stall", gate: stall }, label: "the write stalls before it is sent" });
    return stall;
  },
  writeTokens: (ctx) => tokensOf(ctx),
  armUnknownThenStallResend(ctx, landed) {
    const resend = gate();
    ctx.faults.add({ op: TWI, nth: 1, action: landed ? { kind: "lose-answer" } : { kind: "fail", code: "TimeoutError" }, label: landed ? "the write lands, its answer is lost" : "the write times out before it is sent" });
    ctx.faults.add({ op: TWI, nth: 2, action: { kind: "stall", gate: resend }, label: "the resend stalls" });
    return resend;
  },
  armUnresolvedWrite(ctx, landed) {
    for (let nth = 1; nth <= 1 + RESENDS; nth += 1) {
      ctx.faults.add({ op: TWI, nth, action: landed ? { kind: "lose-answer" } : { kind: "fail", code: "TimeoutError" }, label: `send ${nth}: ${landed ? "applied, answer lost" : "never sent, timed out"}` });
    }
  },
};

/* The ESCROW-3B end-to-end driver (as escrow3bBackend.test.ts): the real replay, with GameEnd grafted on at the seal. */
quietConsole();
const endedReplay =
  (graft: Record<string, unknown> = {}): PrefixReplay =>
  (prefix) => {
    const real = serverPrefixReplay(BUILD)(prefix);
    if (!real.ok) return real;
    return { ok: true, board: { ...real.board, current_round_type: "GameEnd", bank_broken: true, ...graft } as GameStateResponse };
  };
async function sealGame(world: World, gameId: string): Promise<void> {
  const entries = world.logs.get(gameId) ?? [];
  const coordinator = createSettlementCoordinator({
    store: world.financial,
    replay: world.replay,
    isFinancial: () => true,
    serving: world.service.serving,
    now: () => world.clock.now,
    warn: (line) => world.warnings.push(line),
    schedule: () => ({ cancel: () => undefined }),
    onIntentPrepared: (id) => world.service.onIntentPrepared(id),
  });
  coordinator.onGameplayClosed({ gameId, record: { game_id: gameId, money: null, started_at: world.clock.now } as never, seal: sealOf(entries, true)!, recovered: false, entries });
  await coordinator.drain();
}

/* ================================================================== */
/*  1. JOURNAL_CASES                                                    */
/* ================================================================== */

runConformance("signing journal", [ledgerSubject], JOURNAL_CASES);

/* ================================================================== */
/*  2. What only the ledger has                                         */
/* ================================================================== */

const INSTANCE = "5:juno|7:uni-7|4:conf|1:7";
const digest = (byte: string) => ({ codec: "18JUNO/v1" as const, purpose: "settle" as const, hex: byte.repeat(32) });
const reserve = (journal: DynamoSigningLedger, seq: string, byte: string, key = 1) => journal.reserveSettlement({ instance: INSTANCE, seq, signer_key_id: key, digest: digest(byte) });
const TX = (n: number) => n.toString(16).toUpperCase().padStart(64, "0");
const attempt = (n: number, over: Record<string, string> = {}) => ({ intent_id: "ab".repeat(32), tx_id: TX(n), account: RELAYER, account_sequence: String(n), expires_after_height: String(100 + n), ...over });
const outcomeOf = async (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    (value) => (value === undefined ? "recorded" : (value as { kind: string }).kind),
    (error: unknown) => (error instanceof SigningJournalError ? `refused:${error.outcome ?? "?"}` : `threw:${String(error)}`),
  );

/** Run a ledger-only case with the harness's fresh context (a fresh table, the case's own faults, cleanup). */
const ledgerCase = (title: string, run: (ctx: CaseContext) => Promise<void>) =>
  test(title, async () => {
    await runCase(ledgerSubject, { id: "LEDGER", title, run: async (_subject, ctx) => run(ctx) });
  });

describe("L5-5 ledger: two independent fences", () => {
  ledgerCase("a RELAYER takeover alone refuses the stale relayer's attempts -- and never a settlement reservation of the same generation", async (ctx) => {
    const { table } = await ledgerTable(ctx);
    const stale = await openFor(ctx);
    await stale.recordAttempt(attempt(1));
    await put(table, fenceItem(2)); // another task minted relayer epoch 2
    assert.equal(await outcomeOf(stale.recordAttempt(attempt(2))), "refused:fenced");
    assert.equal(await outcomeOf(reserve(stale, "4", "aa")), "reserved", "a game's owner reserves under the generation fence only");
    assert.deepEqual((await stale.attemptsOf("ab".repeat(32))).map((a) => a.tx_id), [TX(1)]);
  });

  ledgerCase("an adopted GENERATION refuses everything the stale task writes (a restore's straggler), and it cannot reopen", async (ctx) => {
    const { table } = await ledgerTable(ctx);
    const fencedWhich: string[] = [];
    const stale = await openFor(ctx, { onFenced: (which) => fencedWhich.push(which) });
    assert.equal(await outcomeOf(reserve(stale, "2", "aa")), "reserved");
    await put(table, appgenItem(2));
    assert.equal(await outcomeOf(reserve(stale, "4", "bb")), "refused:fenced");
    assert.equal(await outcomeOf(stale.recordAttempt(attempt(1))), "refused:fenced");
    assert.equal(await outcomeOf(stale.takeOverRelayer()), "refused:fenced");
    assert.deepEqual(fencedWhich, ["generation"], "the owner hears once");
    await assert.rejects(openFor(ctx), (error: SigningJournalError) => error.outcome === "fenced");
    /* The new generation's task still sees every reservation: the ledger is never restored with the app. */
    const next = await openFor(ctx, { generation: 2 });
    assert.deepEqual(await reserve(next, "2", "cc"), { kind: "conflict", digest_hex: "aa".repeat(32) });
    assert.deepEqual(await next.highestReserved(INSTANCE), { seq: "2" });
  });

  ledgerCase("a stale writer is never answered `same`, even for its OWN digest at its own slot", async (ctx) => {
    const { table } = await ledgerTable(ctx);
    const stale = await openFor(ctx);
    assert.deepEqual(await reserve(stale, "2", "aa"), { kind: "reserved" });
    await put(table, appgenItem(2));
    assert.equal(await outcomeOf(reserve(stale, "2", "aa")), "refused:fenced");
  });

  ledgerCase("a stale writer is refused on the SETTLE path too: its unknown write, then another writer's same digest and a moved generation -- fenced, never `same`", async (ctx) => {
    const { table } = await ledgerTable(ctx);
    const stale = await openFor(ctx);
    const resend = gate();
    ctx.faults.add({ op: TWI, nth: 1, action: { kind: "fail", code: "TimeoutError" }, label: "never sent" });
    ctx.faults.add({ op: TWI, nth: 2, action: { kind: "stall", gate: resend }, label: "the resend stalls" });
    const pending = outcomeOf(reserve(stale, "3", "aa"));
    await resend.reached;
    const other = await openDynamoSigningLedger(admin, { table, generation: 1, sleep: zeroWait });
    assert.deepEqual(await reserve(other, "3", "aa"), { kind: "reserved" });
    await put(table, appgenItem(2));
    resend.release();
    assert.equal(await pending, "refused:fenced");
  });

  /* Review F-1: each fence is inside the ATTEMPT's write on its own -- a takeover of ONE fence landing between the
     writer's checks and its write still refuses it (the harness's takeover moves both, which proves neither alone). */
  for (const which of ["relayer", "generation"] as const) {
    ledgerCase(`fence inside the attempt's write, the ${which} fence alone: a ${which} takeover while the attempt is in flight refuses it`, async (ctx) => {
      const { table } = await ledgerTable(ctx);
      const journal = await openFor(ctx);
      await journal.recordAttempt(attempt(1));
      const before = await records(table);
      const stall = gate();
      ctx.faults.add({ op: TWI, action: { kind: "stall", gate: stall }, label: "the attempt stalls before it is sent" });
      const pending = outcomeOf(journal.recordAttempt(attempt(2)));
      await stall.reached;
      await put(table, which === "relayer" ? fenceItem(2) : appgenItem(2));
      stall.release();
      assert.equal(await pending, "refused:fenced");
      assert.equal(await records(table), before, "nothing of the stale attempt was stored");
    });
  }

  ledgerCase("a reservation is NOT relayer-fenced: in flight across a relayer-only takeover, it lands (a game's owner is not the relayer)", async (ctx) => {
    const { table } = await ledgerTable(ctx);
    const journal = await openFor(ctx);
    const stall = gate();
    ctx.faults.add({ op: TWI, action: { kind: "stall", gate: stall }, label: "the reservation stalls before it is sent" });
    const pending = outcomeOf(reserve(journal, "4", "aa"));
    await stall.reached;
    await put(table, fenceItem(2));
    stall.release();
    assert.equal(await pending, "reserved");
  });

  ledgerCase("an epoch is held only with the token that minted it: re-minted at the same number (a deleted fence item), the old holder is refused", async (ctx) => {
    const { table } = await ledgerTable(ctx);
    const old = await openFor(ctx);
    await old.recordAttempt(attempt(1));
    await put(table, fenceItem(1, 1, RELAYER, "someone-else-minted-1"));
    assert.equal(await outcomeOf(old.recordAttempt(attempt(2))), "refused:fenced");
    await assert.rejects(openFor(ctx), (error: SigningJournalError) => error.outcome === "fenced", "and the number alone opens nothing");
  });

  ledgerCase("onFenced: a fence this instance moved past ITSELF is not reported; a newer holder's takeover is, once per epoch", async (ctx) => {
    const { client, table } = await ledgerTable(ctx);
    const heard: string[] = [];
    const journal = await openDynamoSigningLedger(client, { table, generation: 1, relayer: { address: RELAYER }, sleep: zeroWait, onFenced: (which, detail) => heard.push(`${which}: ${detail.slice(0, 40)}`) });
    await journal.takeOverRelayer();
    const stall = gate();
    ctx.faults.add({ op: TWI, action: { kind: "stall", gate: stall }, label: "the attempt stalls" });
    const pending = outcomeOf(journal.recordAttempt(attempt(1)));
    await stall.reached;
    await journal.takeOverRelayer(); // its OWN takeover fences its own in-flight attempt
    stall.release();
    assert.equal(await pending, "refused:fenced");
    assert.deepEqual(heard, [], "not news: this instance moved past that epoch itself");
    await put(table, fenceItem(9));
    assert.equal(await outcomeOf(journal.recordAttempt(attempt(2))), "refused:fenced");
    assert.equal(await outcomeOf(journal.recordAttempt(attempt(3))), "refused:fenced");
    assert.equal(heard.length, 1, `a newer holder took over: reported once (${JSON.stringify(heard)})`);
    assert.match(heard[0], /^relayer: /);
  });

  ledgerCase("open refuses a ledger this task cannot write: no APPGEN, another generation, a newer or damaged APPGEN, a fence at another epoch", async (ctx) => {
    const { table } = await ledgerTable(ctx);
    const refusal = async (why: string, outcome: string) => assert.rejects(openFor(ctx), (error: SigningJournalError) => error.outcome === outcome || assert.fail(`${why}: ${error.outcome} ${error.message}`));
    await put(table, fenceItem(3));
    await refusal("the fence is at epoch 3", "fenced");
    assert.ok(await openFor(ctx, { relayer: { address: RELAYER, held: heldAt(3) } }));
    await assert.rejects(openFor(ctx, { relayer: { address: RELAYER, held: { epoch: 3, token: "someone-else" } } }), (error: SigningJournalError) => error.outcome === "fenced", "the number without the minting token holds nothing");
    assert.ok(await openFor(ctx, { relayer: { address: RELAYER } }), "no epoch held: opens, records nothing");
    await put(table, appgenItem(1, 2));
    await refusal("a newer APPGEN", "unreadable");
    await put(table, { ...LEDGER_KEYS.appgen(), schema: N(1), current_generation: S("one") });
    await refusal("a damaged APPGEN", "unreadable");
    await put(table, appgenItem(7));
    await refusal("another generation", "fenced");
    await assert.rejects(openDynamoSigningLedger((await ledgerTable(ctx)).client, { table, generation: 0 }), /positive integer/);
  });
});

describe("L5-5 ledger: the relayer takeover (the ledger half)", () => {
  ledgerCase("mints epoch + 1 by compare-and-swap; the previous holder's attempts are refused from then on; epochs never go backwards", async (ctx) => {
    const { client, table } = await ledgerTable(ctx);
    const old = await openFor(ctx);
    const next = await openDynamoSigningLedger(client, { table, generation: 1, relayer: { address: RELAYER }, sleep: zeroWait });
    assert.equal(next.relayerEpoch(), null);
    assert.equal(await outcomeOf(next.recordAttempt(attempt(1))), "refused:definite", "no epoch held: nothing is recorded");
    assert.deepEqual(await next.takeOverRelayer(), { epoch: 2 });
    assert.equal(next.relayerEpoch(), 2);
    assert.equal(await outcomeOf(old.recordAttempt(attempt(2))), "refused:fenced");
    await next.recordAttempt(attempt(3));
    assert.deepEqual(await next.takeOverRelayer(), { epoch: 3 });
    assert.equal(await outcomeOf(next.recordAttempt(attempt(4))), "recorded");
    const fence = await getItem(table, LEDGER_KEYS.fence(RELAYER));
    assert.equal(fence?.epoch?.N, "3");
  });

  ledgerCase("two tasks racing a takeover from the SAME epoch: exactly one mints it; one after the other: the newest wins and the earlier is fenced", async (ctx) => {
    const { client, table } = await ledgerTable(ctx);
    const a = await openDynamoSigningLedger(client, { table, generation: 1, relayer: { address: RELAYER }, sleep: zeroWait });
    const b = await openDynamoSigningLedger(client, { table, generation: 1, relayer: { address: RELAYER }, sleep: zeroWait });
    const held = gate();
    ctx.faults.add({ op: TWI, nth: 1, action: { kind: "stall", gate: held }, label: "A's mint stalls after A read epoch 1" });
    const pendingA = a.takeOverRelayer().then((value) => `minted:${value.epoch}`, (error: SigningJournalError) => `refused:${error.outcome}`);
    await held.reached;
    assert.deepEqual(await b.takeOverRelayer(), { epoch: 2 }, "B read epoch 1 too, and minted 2 first");
    held.release();
    assert.equal(await pendingA, "refused:definite", "A's compare-and-swap from epoch 1 is refused: never two holders of one epoch");
    assert.equal(a.relayerEpoch(), null);
    assert.equal(b.relayerEpoch(), 2);
    /* One after the other: A takes over from B (newest wins); B is fenced from then on. */
    assert.deepEqual(await a.takeOverRelayer(), { epoch: 3 });
    assert.equal(await outcomeOf(b.recordAttempt(attempt(1))), "refused:fenced");
    assert.equal(await outcomeOf(a.recordAttempt(attempt(2))), "recorded");
  });

  /* Delta review D-3: identical mint requests (the same token) would be answered as ONE idempotent write. */
  ledgerCase("a mint never takes an injected token: two tasks sending otherwise byte-identical mints (one token source, one frozen clock) still make ONE holder", async (ctx) => {
    const { client, table } = await ledgerTable(ctx);
    const fixed = `fixed-${newRunId()}`;
    const same = { table, generation: 1, relayer: { address: RELAYER }, sleep: zeroWait, newToken: () => fixed, now: () => 0 };
    const a = await openDynamoSigningLedger(client, same);
    const b = await openDynamoSigningLedger(admin, same);
    const stall = gate();
    ctx.faults.add({ op: TWI, nth: 1, action: { kind: "stall", gate: stall }, label: "A's mint stalls after A read epoch 1" });
    const pendingA = a.takeOverRelayer().then((value) => `minted:${value.epoch}`, (error: SigningJournalError) => `refused:${error.outcome}`);
    await stall.reached;
    assert.deepEqual(await b.takeOverRelayer(), { epoch: 2 }, "B read epoch 1 too, and minted 2 first");
    stall.release();
    assert.equal(await pendingA, "refused:definite", "A's mint is its own request, refused by the compare-and-swap -- never taken for B's, replayed");
    assert.equal(a.relayerEpoch(), null);
    assert.equal(b.relayerEpoch(), 2);
  });

  ledgerCase("an unknown mint while ANOTHER task mints that very epoch: the settle reads the minting token -- not ours, so never two holders of one epoch", async (ctx) => {
    const { client, table } = await ledgerTable(ctx);
    const b = await openDynamoSigningLedger(client, { table, generation: 1, relayer: { address: RELAYER }, sleep: zeroWait, resends: RESENDS });
    const resend = gate();
    ctx.faults.add({ op: TWI, nth: 1, action: { kind: "fail", code: "TimeoutError" }, label: "B's mint 1->2 never sent" });
    ctx.faults.add({ op: TWI, nth: 2, action: { kind: "stall", gate: resend }, label: "B's resend stalls" });
    const pending = b.takeOverRelayer().then((value) => `minted:${value.epoch}`, (error: SigningJournalError) => `refused:${error.outcome}`);
    await resend.reached;
    const a = await openDynamoSigningLedger(admin, { table, generation: 1, relayer: { address: RELAYER }, sleep: zeroWait });
    assert.deepEqual(await a.takeOverRelayer(), { epoch: 2 }, "A minted epoch 2 while B's outcome was unknown");
    resend.release();
    assert.equal(await pending, "refused:definite");
    assert.equal(b.relayerEpoch(), null);
    assert.equal(await outcomeOf(b.recordAttempt(attempt(1))), "refused:definite", "B holds no fence");
    assert.equal(await outcomeOf(a.recordAttempt(attempt(2))), "recorded");
  });

  ledgerCase("a takeover whose answer is lost after it landed is settled by its own token; one that never landed while another task minted is not ours", async (ctx) => {
    const { client, table } = await ledgerTable(ctx);
    ctx.faults.add({ op: TWI, nth: 1, action: { kind: "lose-answer" }, label: "the mint lands, answer lost" });
    ctx.faults.add({ op: TWI, nth: 2, action: { kind: "lose-answer" }, label: "its resend: answer lost too" });
    ctx.faults.add({ op: TWI, nth: 3, action: { kind: "fail", code: "TimeoutError" }, label: "resend 2 never sent" });
    ctx.faults.add({ op: TWI, nth: 4, action: { kind: "fail", code: "TimeoutError" }, label: "resend 3 never sent" });
    const a = await openDynamoSigningLedger(client, { table, generation: 1, relayer: { address: RELAYER }, sleep: zeroWait, resends: RESENDS });
    assert.deepEqual(await a.takeOverRelayer(), { epoch: 2 });
    for (let nth = 1; nth <= 1 + RESENDS; nth += 1) ctx.faults.add({ op: TWI, nth, action: { kind: "fail", code: "TimeoutError" }, label: `B's mint, send ${nth}: never sent` });
    const b = await openDynamoSigningLedger(client, { table, generation: 1, relayer: { address: RELAYER }, sleep: zeroWait, resends: RESENDS });
    const pending = outcomeOf(b.takeOverRelayer());
    assert.equal(await pending, "refused:uncertain", "nothing of it is visible and the fence did not move: unknown");
    assert.equal(b.relayerEpoch(), null);
    await put(table, fenceItem(9));
    assert.equal(await outcomeOf(a.recordAttempt(attempt(1))), "refused:fenced");
  });
});

/** The next TransactWriteItems is DELIVERED only when `late` is released; its caller hears a timeout at once (the request
 *  still in flight, as after a client-side timeout). `delivered()`: how DynamoDB answered it when it arrived. */
function deliverLate(client: DynamoDBClient): { readonly late: Gate; readonly name: string; readonly delivered: () => Promise<string> } {
  const late = gate();
  const name = `lateDelivery-${newRunId()}`;
  let armed = true;
  let answer: Promise<string> | null = null;
  client.middlewareStack.add(
    (next, context) => async (args) => {
      if (!armed || (context as { commandName?: string }).commandName !== TWI) return next(args);
      armed = false;
      arrive(late);
      answer = late.opened.then(() => next(args)).then(
        () => "applied",
        (error: unknown) => (error as { name?: string }).name ?? "error",
      );
      throw Object.assign(new Error("injected: timed out, the request is still in flight"), { name: "TimeoutError" });
    },
    { step: "initialize", name },
  );
  return {
    late,
    name,
    delivered: async () => {
      assert.ok(answer !== null, "the late request was sent");
      return answer;
    },
  };
}

/** The next `times` TransactWriteItems are cancelled by a conflicting transaction on `index` (DynamoDB Local does not model
 *  transaction conflicts): each is refused before it is sent, as the service refuses a conflicting transaction. */
function conflictNext(client: DynamoDBClient, times: number, index: number, size: number): string {
  const name = `conflict-${newRunId()}`;
  let left = times;
  client.middlewareStack.add(
    (next, context) => async (args) => {
      if (left <= 0 || (context as { commandName?: string }).commandName !== TWI) return next(args);
      left -= 1;
      const reasons = Array.from({ length: size }, (_, at) => ({ Code: at === index ? "TransactionConflict" : "None" }));
      throw Object.assign(new Error("injected: Transaction cancelled [TransactionConflict]"), { name: "TransactionCanceledException", CancellationReasons: reasons });
    },
    { step: "initialize", name },
  );
  return name;
}

/** From now on, a cancelled TransactWriteItems reports only its TARGETS' failures: the reason of every ConditionCheck (a
 *  fence) reads `None`, as from a service that stops at the first failed condition or reports only some of them --
 *  nothing documents that every failed condition is reported. The request itself reaches DynamoDB Local unchanged. */
function reportOnlyTargets(client: DynamoDBClient): string {
  const name = `targets-only-${newRunId()}`;
  client.middlewareStack.add(
    (next, context) => async (args) => {
      if ((context as { commandName?: string }).commandName !== TWI) return next(args);
      const items = (args as { input?: { TransactItems?: Array<{ ConditionCheck?: unknown }> } }).input?.TransactItems ?? [];
      try {
        return await next(args);
      } catch (error) {
        const cancelled = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
        if (cancelled.name === "TransactionCanceledException" && Array.isArray(cancelled.CancellationReasons)) {
          cancelled.CancellationReasons = cancelled.CancellationReasons.map((reason, at) => (items[at]?.ConditionCheck !== undefined ? { Code: "None" } : reason));
        }
        throw error;
      }
    },
    { step: "initialize", name },
  );
  return name;
}

describe("L5-5 ledger: a stale writer is refused whatever the service reports", () => {
  ledgerCase("a service reporting only the TAKEN TARGET (never the fence): the snapshot reads the fences too -- a stale writer is fenced, never `same`, never `recorded` again", async (ctx) => {
    const { client, table } = await ledgerTable(ctx);
    const stale = await openFor(ctx);
    assert.deepEqual(await reserve(stale, "2", "aa"), { kind: "reserved" });
    await stale.recordAttempt(attempt(1));
    const name = reportOnlyTargets(client);
    try {
      assert.deepEqual(await reserve(stale, "2", "aa"), { kind: "same" }, "control: the fences stand -- the same digest is `same`");
      assert.equal(await outcomeOf(stale.recordAttempt(attempt(1))), "recorded", "control: the same attempt again, idempotent");
      await put(table, fenceItem(2)); // another task minted relayer epoch 2
      assert.equal(await outcomeOf(stale.recordAttempt(attempt(1))), "refused:fenced", "the relayer fence moved: the attempt is never `recorded` again");
      assert.deepEqual(await reserve(stale, "2", "aa"), { kind: "same" }, "a relayer takeover never fences a reservation");
      await put(table, appgenItem(2)); // a newer generation was adopted
      assert.equal(await outcomeOf(reserve(stale, "2", "aa")), "refused:fenced", "the generation moved: never `same`");
      assert.equal(await outcomeOf(reserve(stale, "2", "bb")), "refused:fenced", "nor `conflict`: a stale writer learns nothing but that it is fenced");
    } finally {
      client.middlewareStack.remove(name);
    }
  });

  /* Delta review D-1: the TOKEN (not the epoch number) is what every read-back compares -- the cancellation's and the
     settle's -- and (D-6) neither ever reads APPGEN transactionally. */
  ledgerCase("a fence RE-MINTED at the same epoch number: the old holder's re-record is fenced by the cancellation's read AND by the settle's -- and no transactional read ever names APPGEN", async (ctx) => {
    const { client, table } = await ledgerTable(ctx);
    const old = await openFor(ctx);
    await old.recordAttempt(attempt(1));
    await put(table, fenceItem(1, 1, RELAYER, `re-minted-${newRunId()}`)); // the fence item was lost; epoch 1 minted again by another task
    const name = reportOnlyTargets(client);
    try {
      assert.equal(await outcomeOf(old.recordAttempt(attempt(1))), "refused:fenced", "the cancellation's read: the same number, another minter");
    } finally {
      client.middlewareStack.remove(name);
    }
    ctx.faults.add({ op: TWI, nth: 1, action: { kind: "fail", code: "TimeoutError" }, label: "the re-record's first send: never sent, outcome unknown" });
    assert.equal(await outcomeOf(old.recordAttempt(attempt(1))), "refused:fenced", "the settle's read (its resend was cancelled by the conditions)");
    const transactional = ctx.faults.calls.filter((call) => call.op === "TransactGetItemsCommand");
    assert.ok(transactional.length >= 2, "the attempt's three targets are read as one snapshot");
    assert.ok(transactional.every((call) => !call.detail.includes('"APPGEN"')), "APPGEN -- named by every ledger write -- is never read transactionally (that read would conflict with every write in flight)");
    assert.ok(ctx.faults.calls.some((call) => call.op === "GetItemCommand" && call.detail.includes('"APPGEN"')), "the fences are read with GetItem");
  });

  /* Delta review D-5: damage to a fence item is never taken for a newer writer, and never passes a write. */
  ledgerCase("damage to a FENCE item is `unreadable`, never a takeover: every new attempt and every write it guards is refused, and onFenced hears nothing", async (ctx) => {
    const { table } = await ledgerTable(ctx);
    const heard: string[] = [];
    const journal = await openFor(ctx, { onFenced: (which) => heard.push(which) });
    await journal.recordAttempt(attempt(1));
    await overwrite(table, LEDGER_KEYS.fence(RELAYER), (item) => ({ ...item, kind: S("garbage") }));
    assert.equal(await outcomeOf(journal.recordAttempt(attempt(2))), "refused:unreadable", "a NEW attempt: the fence's kind is inside the write's condition");
    assert.equal(await outcomeOf(journal.recordAttempt(attempt(1))), "refused:unreadable", "a re-record");
    assert.equal(await outcomeOf(reserve(journal, "4", "aa")), "reserved", "a reservation is not relayer-fenced");
    await overwrite(table, LEDGER_KEYS.appgen(), (item) => ({ ...item, current_generation: S("one") }));
    assert.equal(await outcomeOf(reserve(journal, "5", "aa")), "refused:unreadable");
    assert.equal(await outcomeOf(reserve(journal, "4", "aa")), "refused:unreadable", "never `same` either");
    await put(table, appgenItem(1, 2)); // a newer build's APPGEN
    assert.equal(await outcomeOf(reserve(journal, "5", "aa")), "refused:unreadable");
    assert.deepEqual(heard, [], "damage is never reported as a newer writer");
    assert.deepEqual((await journal.attemptsOf("ab".repeat(32))).map((a) => a.tx_id), [TX(1)], "nothing of the refused attempts was stored");
  });
});

describe("L5-5 ledger: transaction conflicts (every ledger write names APPGEN, so concurrent writes conflict there)", () => {
  ledgerCase("a write cancelled only by a conflict is tried again as a NEW request (a fresh token) -- and lands", async (ctx) => {
    const { client } = await ledgerTable(ctx);
    const journal = await openFor(ctx);
    const name = conflictNext(client, 2, 0, 2);
    assert.deepEqual(await reserve(journal, "5", "aa"), { kind: "reserved" });
    client.middlewareStack.remove(name);
    const tokens = tokensOf(ctx);
    assert.equal(tokens.length, 3, "two conflicts, then the request that landed");
    assert.equal(new Set(tokens).size, 3, "an attempt that was definitely not applied is never resent as itself: each retry is a new request");
    const again = conflictNext(client, 1, 4, 5);
    await journal.recordAttempt(attempt(1));
    client.middlewareStack.remove(again);
    assert.deepEqual((await journal.attemptsOf("ab".repeat(32))).map((a) => a.tx_id), [TX(1)]);
  });

  ledgerCase("conflicts past the bound are a DEFINITE refusal (nothing was written); a conflict never hides a fence", async (ctx) => {
    const { client, table } = await ledgerTable(ctx);
    const journal = await openFor(ctx, { conflictRetries: 2 });
    const name = conflictNext(client, 3, 1, 2);
    assert.equal(await outcomeOf(reserve(journal, "5", "aa")), "refused:definite");
    client.middlewareStack.remove(name);
    assert.equal(await records(table), null);
    await put(table, appgenItem(2));
    assert.equal(await outcomeOf(reserve(journal, "5", "aa")), "refused:fenced", "a fenced writer is not retried into anything");
  });
});

describe("L5-5 ledger: ambiguous outcomes, tokens, identities", () => {
  ledgerCase("a write that lands only AFTER its writer gave up (uncertain): a different digest may take the slot first -- and then the late one is refused; never both", async (ctx) => {
    const { client, table } = await ledgerTable(ctx);
    /* The first send is delivered only when the test says so; the writer hears a timeout at once, and every resend
       times out before it is sent: the writer must answer UNCERTAIN, never reserved, never "not written". */
    const { late, name, delivered } = deliverLate(client);
    for (let nth = 1; nth <= RESENDS; nth += 1) ctx.faults.add({ op: TWI, nth: nth + 1, action: { kind: "fail", code: "TimeoutError" }, label: `resend ${nth} never sent` });
    const writer = await openFor(ctx);
    assert.equal(await outcomeOf(reserve(writer, "6", "aa")), "refused:uncertain");
    client.middlewareStack.remove(name);
    const other = await openDynamoSigningLedger(admin, { table, generation: 1, sleep: zeroWait });
    assert.deepEqual(await reserve(other, "6", "bb"), { kind: "reserved" }, "the slot was free: the first write had not landed");
    late.release();
    assert.equal(await delivered(), "TransactionCanceledException", "the late request was processed, and refused by its condition");
    assert.deepEqual(await reserve(other, "6", "aa"), { kind: "conflict", digest_hex: "bb".repeat(32) }, "the late write never took the slot");
    assert.equal((await scanAll(table)).filter((item) => item.pk?.S === `SETTLE#${INSTANCE}`).length, 1);
  });

  ledgerCase("the same, the other way round: the late write lands first -- the next writer's different digest is a conflict naming it, and the writer's own retry is `same`", async (ctx) => {
    const { client, table } = await ledgerTable(ctx);
    const { late, name, delivered } = deliverLate(client);
    for (let nth = 1; nth <= RESENDS; nth += 1) ctx.faults.add({ op: TWI, nth: nth + 1, action: { kind: "fail", code: "TimeoutError" }, label: `resend ${nth} never sent` });
    const writer = await openFor(ctx);
    assert.equal(await outcomeOf(reserve(writer, "6", "aa")), "refused:uncertain");
    client.middlewareStack.remove(name);
    late.release();
    assert.equal(await delivered(), "applied", "the late request landed");
    const other = await openDynamoSigningLedger(admin, { table, generation: 1, sleep: zeroWait });
    assert.deepEqual(await reserve(other, "6", "bb"), { kind: "conflict", digest_hex: "aa".repeat(32) });
    assert.deepEqual(await reserve(writer, "6", "aa"), { kind: "same" }, "the writer's retry signs only its own, now-landed digest");
  });

  ledgerCase("a reused ClientRequestToken with a different digest is refused (IdempotentParameterMismatch), never reserved", async (ctx) => {
    const { table } = await ledgerTable(ctx);
    /* Tokens are global to the account (and to a DynamoDB Local process) for ten minutes: unique per run. */
    const reused = `reused-${newRunId()}`;
    const journal = await openFor(ctx, { newToken: () => reused });
    assert.deepEqual(await reserve(journal, "1", "aa"), { kind: "reserved" });
    assert.equal(await outcomeOf(reserve(journal, "1", "bb")), "refused:definite", "the same token, another request");
    assert.equal(await outcomeOf(reserve(journal, "2", "bb")), "refused:definite", "the same token, another slot");
    const fresh = await openFor(ctx);
    assert.deepEqual(await reserve(fresh, "1", "cc"), { kind: "conflict", digest_hex: "aa".repeat(32) });
    assert.deepEqual(await reserve(fresh, "2", "bb"), { kind: "reserved" }, "the refused request left slot 2 free");
    assert.equal((await scanAll(table)).filter((item) => item.pk?.S === `SETTLE#${INSTANCE}`).length, 2);
  });

  ledgerCase("duplicate delivery of one request (at-least-once transport): one reservation, one attempt", async (ctx) => {
    const { table } = await ledgerTable(ctx);
    const journal = await openFor(ctx);
    ctx.faults.add({ op: TWI, nth: 1, action: { kind: "duplicate" }, label: "the reservation is delivered twice" });
    assert.deepEqual(await reserve(journal, "3", "aa"), { kind: "reserved" });
    ctx.faults.add({ op: TWI, nth: 1, action: { kind: "duplicate" }, label: "the attempt is delivered twice" });
    await journal.recordAttempt(attempt(1));
    const items = await scanAll(table);
    assert.equal(items.filter((item) => item.pk?.S === `SETTLE#${INSTANCE}`).length, 1);
    assert.equal(items.filter((item) => (item.pk?.S ?? "").startsWith("TXID#")).length, 1);
  });

  ledgerCase("a transaction id is recorded once, with one set of facts: another intent, sequence or expiry for it is REFUSED, the first record untouched", async (ctx) => {
    const { table } = await ledgerTable(ctx);
    const journal = await openFor(ctx);
    await journal.recordAttempt(attempt(5));
    const before = await records(table);
    assert.equal(await outcomeOf(journal.recordAttempt(attempt(5, { intent_id: "cd".repeat(32) }))), "refused:definite");
    assert.equal(await outcomeOf(journal.recordAttempt(attempt(5, { account_sequence: "6" }))), "refused:definite");
    assert.equal(await outcomeOf(journal.recordAttempt(attempt(5, { expires_after_height: "999" }))), "refused:definite");
    const { expires_after_height: _dropped, ...noExpiry } = attempt(5);
    assert.equal(await outcomeOf(journal.recordAttempt(noExpiry)), "refused:definite", "an expiry dropped is other facts too");
    assert.equal(await outcomeOf(journal.recordAttempt(attempt(5))), "recorded", "the same attempt again: idempotent");
    assert.equal(await records(table), before);
    assert.deepEqual(await journal.attemptsOf("cd".repeat(32)), []);
  });

  ledgerCase("an attempt for another account, or without a relayer epoch, is refused before anything is sent", async (ctx) => {
    const { client, table } = await ledgerTable(ctx);
    const journal = await openFor(ctx);
    assert.equal(await outcomeOf(journal.recordAttempt({ ...attempt(1), account: "juno1other" })), "refused:definite");
    const none = await openDynamoSigningLedger(client, { table, generation: 1, sleep: zeroWait });
    assert.equal(await outcomeOf(none.recordAttempt(attempt(1))), "refused:definite");
    assert.equal(ctx.faults.count(TWI), 0, "nothing was sent");
    assert.equal(await outcomeOf(journal.recordAttempt({ ...attempt(1), account_sequence: "18446744073709551616" })), "refused:definite", "above u64: never a key");
  });

  ledgerCase("an unknown first attempt, then a resend REFUSED without evaluation (throttled): the snapshot decides -- ours landed -> reserved; nothing landed -> uncertain", async (ctx) => {
    const journal = await openFor(ctx);
    ctx.faults.add({ op: TWI, nth: 1, action: { kind: "lose-answer" }, label: "landed, answer lost" });
    ctx.faults.add({ op: TWI, nth: 2, action: { kind: "fail" }, label: "the resend is throttled" });
    assert.deepEqual(await reserve(journal, "7", "aa"), { kind: "reserved" });
    ctx.faults.add({ op: TWI, nth: 1, action: { kind: "fail", code: "TimeoutError" }, label: "never sent" });
    ctx.faults.add({ op: TWI, nth: 2, action: { kind: "fail" }, label: "the resend is throttled" });
    assert.equal(await outcomeOf(reserve(journal, "8", "aa")), "refused:uncertain");
    assert.deepEqual(await reserve(journal, "8", "aa"), { kind: "reserved" }, "a later write settles the slot");
  });

  ledgerCase("TransactionInProgress on a resend: wait, and resend the SAME request", async (ctx) => {
    const journal = await openFor(ctx);
    ctx.faults.add({ op: TWI, nth: 1, action: { kind: "fail", code: "TimeoutError" }, label: "never sent" });
    ctx.faults.add({ op: TWI, nth: 2, action: { kind: "fail", code: "TransactionInProgressException" }, label: "in progress" });
    assert.deepEqual(await reserve(journal, "9", "aa"), { kind: "reserved" });
    const tokens = tokensOf(ctx);
    assert.equal(tokens.length, 3);
    assert.ok(tokens.every((token) => token === tokens[0]), "one request identity throughout");
  });

  ledgerCase("reads fail closed on damage ANYWHERE in the partition: a damaged lower reservation refuses highestReserved (never an answer that skips it)", async (ctx) => {
    const { table } = await ledgerTable(ctx);
    const journal = await openFor(ctx);
    for (const seq of ["9", "10", "11"]) await reserve(journal, seq, "aa");
    await overwrite(table, LEDGER_KEYS.settle(INSTANCE, "9", 1), (item) => ({ ...item, seq: S("12") }));
    await assert.rejects(journal.highestReserved(INSTANCE), (error: Error) => error instanceof LedgerUnreadableError && error.format === "corrupt");
    await assert.rejects(journal.reservations(INSTANCE), LedgerUnreadableError);
    assert.equal(await outcomeOf(reserve(journal, "9", "aa")), "refused:unreadable");
  });

  ledgerCase("the items are exactly the documented ones", async (ctx) => {
    const { table } = await ledgerTable(ctx);
    const run = newRunId();
    const journal = await openFor(ctx, { newToken: (() => { let n = 0; return () => `token-${run}-${(n += 1)}`; })() });
    await reserve(journal, "12", "aa", 3);
    await journal.recordAttempt(attempt(7));
    const byKey = new Map((await scanAll(table)).filter(isRecord).map((item) => [`${item.pk?.S} ${item.sk?.S}`, item]));
    assert.deepEqual([...byKey.keys()].sort(), [
      `ATTEMPT#${RELAYER} SEQ#00000000000000000007#TX#${TX(7)}`,
      `ATTI#${"ab".repeat(32)} SEQ#00000000000000000007#TX#${TX(7)}`,
      `SETTLE#${INSTANCE} SEQ#00000000000000000012#K#00003`,
      `TXID#${TX(7)} TXID`,
    ]);
    const settle = byKey.get(`SETTLE#${INSTANCE} SEQ#00000000000000000012#K#00003`);
    assert.deepEqual(Object.keys(settle ?? {}).sort(), ["at", "codec", "digest_hex", "generation", "instance", "kind", "pk", "schema", "seq", "signer_key_id", "sk", "token"]);
    assert.equal(settle?.digest_hex?.S, "aa".repeat(32));
    assert.equal(settle?.token?.S, `token-${run}-1`);
    const txid = byKey.get(`TXID#${TX(7)} TXID`);
    assert.deepEqual(Object.keys(txid ?? {}).sort(), ["account", "at", "expires_after_height", "generation", "intent_id", "kind", "pk", "relayer_epoch", "schema", "sequence", "sk", "token", "tx_id"]);
    assert.equal(txid?.relayer_epoch?.N, "1");
  });
});

/* ================================================================== */
/*  3. The money game end to end over the ledger, with KMS answers lost */
/* ================================================================== */

describe("L5-5: ESCROW-3B's money game end to end with the DynamoDB ledger as its journal -- and KMS answers lost AFTER the signature was made", () => {
  ledgerCase("deal -> checkpoints -> seal -> terminal checkpoint + Settle -> Finalize: every signed digest is the one its slot holds; every broadcast attempt is fenced in the ledger; a restart reads it all back", async (ctx) => {
    const { client, table } = await ledgerTable(ctx);
    await put(table, fenceItem(1, 1, RELAYER_ADDRESS));
    const journal = await openDynamoSigningLedger(client, { table, generation: 1, relayer: { address: RELAYER_ADDRESS }, now: () => ctx.now(), sleep: zeroWait, resends: RESENDS });
    assert.deepEqual(await journal.takeOverRelayer(), { epoch: 2 }, "the relayer role, taken the production way: the ledger mints the epoch");
    /* Every digest either key was asked to sign, and the first answer of each lost after the signature was made. */
    const settlementAsked: string[] = [];
    const relayerAsked: string[] = [];
    const loseFirst = (asked: string[], budget: { lost: number }) => (inner: DigestSigner): DigestSigner => ({
      ...inner,
      async sign(bytes) {
        const signature = await inner.sign(bytes);
        asked.push(bytes.toString("hex"));
        if (budget.lost > 0) {
          budget.lost -= 1;
          throw new SignerError("unavailable", "KMS Sign failed: no answer; the outcome is unknown", { signatureMayExist: true });
        }
        return signature;
      },
    });
    const world = makeWorld({ replay: endedReplay(), journal, wrapSettlementKey: loseFirst(settlementAsked, { lost: 2 }), wrapRelayerKey: loseFirst(relayerAsked, { lost: 1 }) });
    /* A lost settlement answer fails that checkpoint job; the service's periodic sweep retries it (in production every
       minute; here once per driven round). */
    const driveSweeping = (done: () => Promise<boolean>, max = 40) =>
      world.drive(async () => {
        if (await done()) return true;
        await world.service.sweepChain();
        return false;
      }, max);
    await startedGame(world);
    const session = play(world, GAME_A, 0);
    await driveSweeping(async () => (await world.financial.load(GAME_A))?.chain.checkpoint_confirmed !== null);
    toStockRound(world, GAME_A, session);
    await driveSweeping(async () => (await world.financial.load(GAME_A))?.chain.checkpoint_confirmed?.log_len === session.entries.length);
    move(world, GAME_A, session, ALICE, PASS);
    await world.service.idle();
    await sealGame(world, GAME_A);
    await driveSweeping(async () => (await world.financial.load(GAME_A))?.phase === "closed", 80);

    const record = await world.financial.load(GAME_A);
    assert.equal(record?.chain_outcome?.state, "SETTLED");
    const instance = escrowInstanceKey(record!.binding!.escrow!);
    const reserved = await journal.reservations(instance);
    const intents = await world.intents.listGame(GAME_A);
    const signedPayloads = intents.filter((intent) => intent.op.kind === "checkpoint" || intent.op.kind === "settle");
    assert.ok(signedPayloads.length >= 3, "the deal, a boundary, the terminal checkpoint and the Settle");
    for (const intent of signedPayloads) {
      const op = intent.op as { readonly seq: string; readonly settle_digest: string; readonly signer_key_id: number };
      const slot = reserved.filter((entry) => entry.seq === op.seq && entry.signer_key_id === op.signer_key_id);
      assert.deepEqual(slot.map((entry) => entry.digest_hex), [op.settle_digest], `seq ${op.seq}: the ledger holds exactly the digest the intent carries`);
    }
    /* KMS was asked to sign a settlement digest only after the ledger held it -- and never another digest at a slot. */
    const held = new Set(reserved.map((entry) => entry.digest_hex));
    assert.ok(settlementAsked.length > signedPayloads.length, "the lost answer was retried");
    assert.ok(settlementAsked.every((hex) => held.has(hex)), "every digest given to the settlement key is one its slot holds");
    /* Every attempt the chain saw is in the ledger, under the relayer's account and fence. */
    const attempts = intents.flatMap((intent) => intent.attempts.map((attempt) => ({ intent, attempt })));
    const byAccount = new Set((await journal.allAttempts(RELAYER_ADDRESS)).map((entry) => entry.tx_id));
    for (const { intent, attempt } of attempts) {
      assert.ok(byAccount.has(attempt.tx_hash), `attempt ${attempt.tx_hash.slice(0, 12)} is journalled under the relayer`);
      assert.ok((await journal.attemptsOf(intent.intent_id)).some((entry) => entry.tx_id === attempt.tx_hash));
    }
    assert.ok(relayerAsked.length > attempts.length, "a relayer signature whose answer was lost never became an attempt");
    const txids = (await scanAll(table)).filter((item) => (item.pk?.S ?? "").startsWith("TXID#"));
    assert.equal(txids.length, attempts.length, "only broadcastable attempts were ever recorded");
    assert.ok(txids.every((item) => item.relayer_epoch?.N === "2" && item.generation?.N === "1"));
    /* A restart over the same ledger (a new process): the history check reads the reservations back, nothing is held. */
    const reopened = await openDynamoSigningLedger(client, { table, generation: 1, sleep: zeroWait });
    assert.deepEqual(await reopened.highestReserved(instance), { seq: reserved.reduce((best, entry) => (BigInt(entry.seq) > BigInt(best) ? entry.seq : best), "0") });
    const summary = await world.restart();
    assert.equal(summary.held, 0);
  });
});
