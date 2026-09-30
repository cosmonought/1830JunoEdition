// server/src/escrow/l6_7RelayerDurability.test.ts
//
// ==================================================================
//  LIVE-6 L6-7: THE DEFERRED L5-6 RELAYER ITEMS -- QUEUE DISCOVERY, THE BOUNDED GUARD, F-L5-17, F-L5-16, THE OPEN-GAME LOAD
// ==================================================================
//
// ESCROW-3B's world on the offline chain, with memory stores (`npm test`). The DynamoDB half -- the strict RELAYQ# and
// FINKEYS / FINIDX# reads, the ledger's bounded range and the request counts that prove bounded work -- is
// `persistence/conformance/l6_7RelayerScale.dynamoLocal.test.ts`.
//
//   §1 RELAYQ-driven load: the queue is the work (never every game's intents); a terminal intent whose entry left the
//      queue is not work; a queue that disagrees with its intent is reported and paged, never invented into work; a
//      damaged queue fails the load; a pass re-reads the queue; a terminal write racing the load is not a disagreement.
//   §2 the forgotten-attempt guard bounded by the chain's sequence: a forgotten attempt that may still land blocks;
//      spent and expired ones do not; the journal is read from the chain's sequence only.
//   §3 F-L5-17: only chain and contract answers spend an intent's failure budget; an operational failure backs off in
//      memory, writes nothing, pages when its budget is spent, and never holds; the non-counting matrix.
//   §4 F-L5-16: wait + page -- another deployment's intent, a verdict that stays uncomputable, passes that keep failing.
//   §5 PROCESS (no queue): the load is byte-for-byte LIVE-5's -- every game listed, every journalled attempt read.
//   §6 the escrow load and chain sweep over the open money games only.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ALICE, BOB, quietConsole } from "../rooms/testSupport";
import { createMemoryChainIntentStore, isLiveAttempt, junoInstanceOf, newChainIntent, supersededIntent, type ChainIntentRecord } from "./chainIntents";
import { createMemoryFinancialGameStore } from "./financialGameStore";
import { RELAYER_EXECUTE } from "./juno/junoContract";
import { SignerError, type DigestSigner } from "./juno/signer";
import { createMemorySigningJournal, SigningJournalError, type InspectableSigningJournal } from "./signingJournal";
import { createMemoryWalletTicketStore } from "./walletTickets";
import { CHAIN_ID, CONTRACT, fundedGame, GAME_A, GAME_B, makeWorld, PIN, RELAYER_ADDRESS, startedGame, T0, VARIANTS, WALLETS, type World, type WorldOptions } from "./escrow3bSupport";
import { newFinancialRecord, transitionFinancial } from "./moneyLifecycle";
import { currentMoneyContinuation } from "./moneyContinuation";

quietConsole();

/* ---------------- helpers ---------------- */

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
/** A valid game id for synthetic history (`g_` + 25 base-32 characters + a valid last character). */
function gameIdOf(n: number): string {
  let digits = "";
  let rest = n;
  for (let i = 0; i < 25; i += 1) {
    digits = ALPHABET[rest % 32] + digits;
    rest = Math.floor(rest / 32);
  }
  return `g_${digits}r`;
}

type QueuedStore = ReturnType<typeof createMemoryChainIntentStore>;

function queuedWorld(over: Partial<WorldOptions> = {}): World & { readonly store: QueuedStore } {
  const store = createMemoryChainIntentStore({ relayQueue: true });
  const world = makeWorld({ intents: store, ...over });
  return Object.assign(world, { store });
}

/** A synthetic intent of a synthetic game (a Finalize of chain game `chainGameId`), on this relayer's deployment. */
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

/** `count` historic games, each with one intent made (queued) and then superseded (its queue entry gone with it). */
async function history(store: QueuedStore, count: number): Promise<void> {
  for (let n = 0; n < count; n += 1) {
    const intent = syntheticIntent(gameIdOf(10_000 + n), 50_000 + n);
    assert.equal((await store.create(intent)).kind, "created");
    assert.equal((await store.put(supersededIntent(intent, "history", T0 + 1), 1)).kind, "committed");
  }
}

async function pendingStart(world: World, gameId: string = GAME_A): Promise<void> {
  assert.ok((await world.service.createMoneyGame(gameId)).ok);
  const chainGameId = await fundedGame(world, gameId);
  assert.ok((await world.service.bindChainGame(gameId, chainGameId, VARIANTS)).ok);
  assert.ok((await world.service.requestStart(gameId, [{ player_id: ALICE }, { player_id: BOB }])).ok);
}

const startOf = async (world: World, gameId: string = GAME_A): Promise<ChainIntentRecord> => (await world.intents.listGame(gameId)).find((intent) => intent.op.kind === "start") as ChainIntentRecord;
const started = (world: World, gameId: string = GAME_A) => async () => (await world.financial.load(gameId))?.chain.started !== null;
const opsOf = (world: World, event: string) => world.ops.lines.filter((line) => line.event === event);
const resetReads = (store: QueuedStore) => Object.assign(store.reads, { load: 0, listGame: 0, games: 0, formatOf: 0, queue: 0 });
const relayerSequence = (world: World): bigint => (world.chain.accounts.get(RELAYER_ADDRESS) as { sequence: bigint }).sequence;
const setRelayerSequence = (world: World, sequence: bigint) => void ((world.chain.accounts.get(RELAYER_ADDRESS) as { sequence: bigint }).sequence = sequence);
const TX = (n: number) => n.toString(16).toUpperCase().padStart(64, "0");

/** A journal that records how it was read. */
function spyJournal(inner: InspectableSigningJournal = createMemorySigningJournal(() => T0)) {
  const calls = { allAttempts: 0, attemptsFrom: [] as string[] };
  const journal: InspectableSigningJournal = {
    ...inner,
    reserveSettlement: (entry) => inner.reserveSettlement(entry),
    recordAttempt: (entry) => inner.recordAttempt(entry),
    highestReserved: (instance) => inner.highestReserved(instance),
    reservations: (instance) => inner.reservations(instance),
    attemptsOf: (intentId) => inner.attemptsOf(intentId),
    async allAttempts(account) {
      calls.allAttempts += 1;
      return inner.allAttempts(account);
    },
    async attemptsFrom(account, from) {
      calls.attemptsFrom.push(from);
      return (inner.attemptsFrom as NonNullable<InspectableSigningJournal["attemptsFrom"]>)(account, from);
    },
  };
  return { journal, calls, inner };
}

/* ==================================================================
    §1 RELAYQ-DRIVEN LOAD
   ================================================================== */

describe("§1 the relay queue is the relayer's work", () => {
  test("the load reads the queue and each queued intent by its key -- never the game listing -- and the work grows with the queue, not with history", async () => {
    const reads: Array<Record<string, number>> = [];
    for (const historic of [5, 200]) {
      const world = queuedWorld();
      await history(world.store, historic);
      await pendingStart(world);
      assert.equal(world.store.queue.size, 1, "only the live Start is queued; every historic intent left the queue with its terminal write");
      await world.restart();
      await world.service.idle();
      /* The relayer's own load, measured alone (the service's jobs read their own games' intents). */
      resetReads(world.store);
      await world.relayer.load();
      reads.push({ ...world.store.reads });
      assert.equal(world.relayer.status().discovery, "queue");
      assert.equal(world.relayer.status().open, 1);
      /* The work is there: the Start lands from what the queue named. */
      await world.drive(started(world));
    }
    for (const counts of reads) {
      assert.equal(counts.games, 0, "no game listing");
      assert.equal(counts.listGame, 0, "no per-game intent listing");
    }
    /* The relayer's load read exactly the queue and its one entry, whatever the history. */
    assert.deepEqual(reads[0], reads[1]);
    assert.deepEqual([reads[0].queue, reads[0].load], [1, 1]);
  });

  test("a terminal intent whose entry left the queue is never loaded as work; a HELD intent keeps its entry and is observed", async () => {
    const world = queuedWorld();
    await pendingStart(world);
    await world.drive(started(world)); // A's Start is confirmed: terminal, out of the queue
    assert.equal((await startOf(world)).status, "confirmed");
    assert.equal(world.store.queue.size, 0);
    /* B's Start, held: it stays queued (it may carry a live attempt the next relayer must observe). */
    await pendingStart(world, GAME_B);
    const startB = await startOf(world, GAME_B);
    assert.equal((await world.store.put({ ...startB, status: "held", hold: { code: "chain-intent-held", detail: "test", at: T0 }, record_version: 2, updated_at: T0 }, 1)).kind, "committed");
    assert.equal(world.store.queue.size, 1);
    /* The relayer's load alone (a restart would also run the service's start reconciliation, which releases a held
       Start with nothing live -- the owner's business, not the relayer's discovery). */
    await world.service.idle();
    resetReads(world.store);
    await world.relayer.load();
    assert.equal(world.relayer.status().open, 1, "the held intent is work (observed), the confirmed Start is not");
    assert.deepEqual([world.store.reads.queue, world.store.reads.load], [1, 1], "the confirmed Start was never read");
  });

  test("the queue disagreeing with its intent is DETECTED -- reported, paged, never invented into work; the load still succeeds", async () => {
    const world = queuedWorld();
    await pendingStart(world);
    const start = await startOf(world);
    /* (a) an entry for an intent the store does not have; (b) an entry still queued for a superseded intent;
       (c) an entry whose creation time is not its intent's (the intent is still worked). */
    world.store.queue.set(`${GAME_B}/${"ab".repeat(32)}`, { game_id: GAME_B, intent_id: "ab".repeat(32), created_at: T0 });
    const gone = syntheticIntent(gameIdOf(7), 700);
    await world.store.create(gone);
    await world.store.put(supersededIntent(gone, "done", T0 + 1), 1);
    world.store.queue.set(`${gone.game_id}/${gone.intent_id}`, { game_id: gone.game_id, intent_id: gone.intent_id, created_at: gone.created_at });
    world.store.queue.set(`${GAME_A}/${start.intent_id}`, { game_id: GAME_A, intent_id: start.intent_id, created_at: start.created_at + 5 });
    await world.restart();
    const status = world.relayer.status();
    assert.equal(status.queue_mismatch, 3);
    assert.equal(status.open, 1, "only the Start is work -- the missing and the terminal ones are not invented");
    const kinds = opsOf(world, "chain.relay-queue-mismatch").map((line) => line.kind).sort();
    assert.deepEqual(kinds, ["created-at", "missing", "terminal"]);
    const pages = opsOf(world, "chain.relayer-page").filter((line) => line.condition === "relay-queue-mismatch");
    assert.equal(pages.length, 3, "a disagreement pages at once");
    assert.equal(status.paging.paged, 3);
    /* The Start (created-at disagreement) is still the intent's work: it lands. */
    await world.drive(started(world));
    /* Entries repaired (the operator removed the stray ones): the next load clears the conditions, once each. */
    world.store.queue.delete(`${GAME_B}/${"ab".repeat(32)}`);
    world.store.queue.delete(`${gone.game_id}/${gone.intent_id}`);
    world.store.queue.delete(`${GAME_A}/${start.intent_id}`);
    await world.relayer.load();
    assert.equal(world.relayer.status().queue_mismatch, 0);
    assert.equal(opsOf(world, "chain.relayer-page-cleared").filter((line) => line.condition === "relay-queue-mismatch").length, 3);
  });

  test("a DAMAGED queue entry fails the load (fail-closed: it may name the live attempt's intent); nothing is signed", async () => {
    const world = queuedWorld();
    await pendingStart(world);
    world.store.queue.set("damage", "malformed");
    await assert.rejects(world.restart(), /relay-queue entry damage is damaged/);
    assert.equal(world.relayer.status().open, 0);
    await world.relayer.pass();
    assert.deepEqual(world.chain.broadcasts, [], "nothing signed or broadcast");
    world.store.queue.delete("damage");
    await world.restart();
    await world.drive(started(world));
  });

  test("a queued intent that cannot be read (damage) fails the load, as a damaged listing always did (review #3); another build's format skips its game", async () => {
    const world = queuedWorld();
    await pendingStart(world);
    const start = await startOf(world);
    world.store.records.set(`${GAME_A}/${start.intent_id}`, "unreadable");
    await assert.rejects(world.restart(), /unreadable/);
    world.store.records.set(`${GAME_A}/${start.intent_id}`, "newer");
    await world.restart();
    assert.equal(world.relayer.status().skipped_games, 1);
    assert.equal(world.relayer.status().open, 0);
    assert.equal(opsOf(world, "chain.intents-skipped").length, 1);
  });

  test("a pass re-reads the queue (at most once per refresh interval): an intent another pool's owner made joins the work without a poke", async () => {
    /* Two processes over the same durable stores: `relayerTask` relays; `ownerTask` (another pool's owner) makes the
       money game and its Start -- it pokes only its own relayer, never this one. */
    const store = createMemoryChainIntentStore({ relayQueue: true });
    const financial = createMemoryFinancialGameStore();
    const journal = createMemorySigningJournal(() => T0);
    const shared = { intents: store, financial, journal, tickets: createMemoryWalletTicketStore() };
    const relayerTask = makeWorld({ ...shared, relayerTuning: { queueRefreshMs: 30_000 } });
    await relayerTask.restart(); // an empty queue
    const ownerTask = makeWorld(shared);
    await pendingStart(ownerTask);
    const start = await startOf(ownerTask);
    const funded = ownerTask.chain.games.get(Number(start.op.chain_game_id));
    assert.ok(funded !== undefined);
    relayerTask.chain.games.set(Number(start.op.chain_game_id), funded); // one chain, seen from both
    await relayerTask.relayer.pass();
    assert.equal(relayerTask.relayer.status().open, 0, "not before the refresh interval");
    relayerTask.clock.now += 30_000;
    const before = store.reads.queue;
    await relayerTask.relayer.pass();
    assert.equal(store.reads.queue, before + 1, "one queue read");
    assert.equal(relayerTask.relayer.status().open + relayerTask.relayer.status().skipped + relayerTask.relayer.status().undecided, 1, "the Start joined this relayer's work");
  });

  test("review M1: a queue that cannot be RE-read (damage) pages at once under its own condition -- the known work goes on -- and clears only when a re-read succeeds", async () => {
    const world = queuedWorld({ relayerTuning: { queueRefreshMs: 10_000 } });
    await pendingStart(world);
    await world.restart();
    world.store.queue.set("damage", "malformed");
    world.clock.now += 10_000;
    await world.relayer.pass(); // the re-read fails; the Start (known) is still signed and broadcast
    assert.ok((await startOf(world)).attempts.some(isLiveAttempt), "the known work went on");
    const pages = () => opsOf(world, "chain.relayer-page").filter((line) => line.condition === "relay-queue-unreadable");
    assert.equal(pages().length, 1, "damage pages at once");
    for (let round = 0; round < 3; round += 1) {
      world.clock.now += 2_000; // passes between re-reads succeed: the condition stays
      await world.relayer.pass();
    }
    assert.equal(world.relayer.status().paging.conditions.filter((entry) => entry.condition === "relay-queue-unreadable").length, 1, "not cleared by passes that did not re-read");
    world.store.queue.delete("damage");
    world.clock.now += 10_000;
    await world.relayer.pass();
    assert.equal(opsOf(world, "chain.relayer-page-cleared").filter((line) => line.condition === "relay-queue-unreadable").length, 1);
    await world.drive(started(world));
  });

  test("a later queue-mode load REPLACES the forgotten-attempt guard (a complete recomputation), never keeps a stale one", async () => {
    const spy = spyJournal();
    const world = queuedWorld({ journal: spy.journal });
    await pendingStart(world);
    const now = relayerSequence(world);
    await spy.journal.recordAttempt({ intent_id: "cd".repeat(32), tx_id: TX(2), account: RELAYER_ADDRESS, account_sequence: now.toString(), expires_after_height: String(world.chain.height + 50) });
    await world.relayer.load();
    assert.equal(world.relayer.status().forgotten_guard?.attempts, 1);
    setRelayerSequence(world, now + BigInt(1)); // the chain spent it
    await world.relayer.load();
    assert.equal(world.relayer.status().forgotten_guard, null);
  });

  test("a terminal write racing the load (the entry read, then the intent made terminal) is NOT a disagreement", async () => {
    const world = queuedWorld();
    const intent = syntheticIntent(gameIdOf(3), 300);
    await world.store.create(intent);
    const queueRead = world.store.relayQueue as () => Promise<unknown[]>;
    let first = true;
    (world.store as { relayQueue: () => Promise<unknown[]> }).relayQueue = async () => {
      const entries = await queueRead();
      if (first) {
        first = false;
        /* The owner supersedes it right after the relayer read the queue (the entry leaves with that write). */
        await world.store.put(supersededIntent(intent, "released", T0 + 2), 1);
      }
      return entries;
    };
    await world.restart();
    assert.equal(world.relayer.status().queue_mismatch, 0);
    assert.equal(opsOf(world, "chain.relay-queue-mismatch").length, 0);
    assert.equal(world.relayer.status().open, 0);
  });
});

/* ==================================================================
    §2 THE FORGOTTEN-ATTEMPT GUARD, BOUNDED BY THE CHAIN'S SEQUENCE
   ================================================================== */

describe("§2 the forgotten-attempt guard reads only what may still be live", () => {
  test("a forgotten attempt that may still land (at the chain's sequence, not expired) BLOCKS; spent, nothing signed over it", async () => {
    const spy = spyJournal();
    const world = queuedWorld({ journal: spy.journal });
    await pendingStart(world);
    const now = relayerSequence(world);
    await spy.journal.recordAttempt({ intent_id: "cd".repeat(32), tx_id: TX(1), account: RELAYER_ADDRESS, account_sequence: now.toString(), expires_after_height: String(world.chain.height + 50) });
    await world.restart();
    assert.deepEqual(spy.calls.attemptsFrom, [now.toString()], "read from the chain's sequence on");
    assert.equal(spy.calls.allAttempts, 0, "never the account's whole history");
    assert.equal(world.relayer.status().forgotten_guard?.attempts, 1);
    await world.relayer.pass();
    assert.equal((await startOf(world)).attempts.length, 0, "nothing signed at a sequence the forgotten attempt may take");
    /* The chain spends the sequence (the forgotten bytes, or anything else): signing resumes at the next one. */
    setRelayerSequence(world, now + BigInt(1));
    await world.drive(started(world));
    assert.equal((await startOf(world)).attempts[0].sequence, (now + BigInt(1)).toString());
  });

  test("hundreds of SPENT historical attempts, and an EXPIRED one at the current sequence, guard nothing", async () => {
    const spy = spyJournal();
    const world = queuedWorld({ journal: spy.journal });
    await pendingStart(world);
    for (let n = 0; n < 300; n += 1) await spy.journal.recordAttempt({ intent_id: "ef".repeat(32), tx_id: TX(1000 + n), account: RELAYER_ADDRESS, account_sequence: String(n), expires_after_height: String(n + 10) });
    setRelayerSequence(world, BigInt(300));
    await spy.journal.recordAttempt({ intent_id: "ef".repeat(32), tx_id: TX(9), account: RELAYER_ADDRESS, account_sequence: "300", expires_after_height: String(world.chain.height - 1) });
    await world.restart();
    assert.deepEqual(spy.calls.attemptsFrom, ["300"]);
    assert.equal(world.relayer.status().forgotten_guard, null);
    assert.equal(opsOf(world, "chain.forgotten-attempts").length, 0, "no false page for spent or expired history");
    await world.drive(started(world));
  });

  test("an attempt a queued intent holds is known (no guard); a journal without the bounded read is filtered by the same rule", async () => {
    const inner = createMemorySigningJournal(() => T0);
    const { attemptsFrom: _unused, ...withoutRange } = inner;
    void _unused;
    const world = queuedWorld({ journal: withoutRange as InspectableSigningJournal });
    await pendingStart(world);
    await world.relayer.pass(); // the Start is signed and broadcast: live, journalled, stored
    assert.ok((await startOf(world)).attempts.some(isLiveAttempt));
    const sequence = relayerSequence(world);
    for (let n = 0; n < 50; n += 1) await inner.recordAttempt({ intent_id: "aa".repeat(32), tx_id: TX(5000 + n), account: RELAYER_ADDRESS, account_sequence: String(n), expires_after_height: "1" });
    await world.restart();
    assert.equal(world.relayer.status().forgotten_guard, null, "the live Start's attempt is known; the old ones are spent or expired");
    await world.drive(started(world));
    assert.ok(sequence >= BigInt(0));
  });
});

/* ==================================================================
    §3 F-L5-17: ONLY CHAIN AND CONTRACT ANSWERS SPEND AN INTENT'S BUDGET
   ================================================================== */

describe("§3 F-L5-17", () => {
  test("an OPERATIONAL failure (the financial record's store throws inside the admission) spends no intent budget, writes nothing, backs off in memory, pages when its budget is spent -- never a hold; the store recovers and the Start lands", async () => {
    const world = queuedWorld({ relayerTuning: { failureBudget: 3 } });
    await pendingStart(world);
    const before = await startOf(world);
    const admit = world.service.admit.bind(world.service);
    let failing = true;
    world.service.admit = async (intent) => {
      if (failing) throw new Error("ProvisionedThroughputExceededException: the game table is throttling");
      return admit(intent);
    };
    for (let round = 0; round < 12; round += 1) {
      await world.relayer.pass();
      world.clock.now += 20_000;
    }
    const after = await startOf(world);
    assert.equal(after.record_version, before.record_version, "nothing written for it (no defer, no hold)");
    assert.equal(after.retry.failures, 0, "no intent budget spent");
    assert.equal(after.status, "pending");
    const troubles = opsOf(world, "chain.relayer-trouble");
    assert.ok(troubles.length >= 3 && troubles.length < 12, `backed off in memory (${troubles.length} tries in 12 passes)`);
    const pages = opsOf(world, "chain.relayer-page").filter((line) => line.condition === "operational-failure");
    assert.equal(pages.length, 1, "one page when the operational budget is spent");
    assert.equal(pages[0].streak, 3);
    assert.equal(world.relayer.status().troubled, 1);
    assert.equal(world.relayer.status().paging.paged, 1);
    failing = false;
    world.clock.now += 700_000; // past the longest backoff
    await world.relayer.pass(); // the admission answers again: the Start is signed and broadcast (in flight, not yet terminal)
    assert.ok((await startOf(world)).attempts.some(isLiveAttempt));
    assert.equal(world.relayer.status().troubled, 0, "the operational condition ended with the first advance that got past it");
    assert.equal(opsOf(world, "chain.relayer-page-cleared").filter((line) => line.condition === "operational-failure").length, 1);
    await world.drive(started(world));
    assert.equal(opsOf(world, "chain.intent-held").length, 0, "never held");
  });

  test("a CONTRACT answer this build cannot read still spends the budget and, spent, holds (the existing rule, unchanged)", async () => {
    const world = queuedWorld({ relayerTuning: { failureBudget: 2 } });
    await pendingStart(world);
    const smart = world.chain.smart.bind(world.chain);
    let garbage = true;
    world.chain.smart = async (contract: string, query: string) => (garbage && query.includes('"game"') ? { not: "a game response" } : smart(contract, query));
    await world.relayer.pass();
    assert.equal((await startOf(world)).retry.failures, 1, "counted");
    world.clock.now += 60_000;
    await world.relayer.pass();
    assert.equal((await startOf(world)).status, "held", "the budget spent: held for an operator");
    garbage = false;
    assert.equal(opsOf(world, "chain.relayer-trouble").length, 0, "not an operational failure");
  });

  test("the non-counting matrix: a withheld side effect, a KMS `unavailable`, a non-SignerError while signing, the ledger refusing the attempt -- none spends the intent's budget or writes a hold", async () => {
    type Case = { readonly name: string; readonly arrange: (world: World, key: { mode: string }) => World | void };
    let journalRefusals = 0;
    const cases: Case[] = [
      { name: "SignerError unavailable (F-L5-2)", arrange: (_world, key) => void (key.mode = "unavailable") },
      { name: "a non-SignerError from the signing step", arrange: (_world, key) => void (key.mode = "socket") },
      {
        name: "the ledger refused the attempt",
        arrange: (world) => {
          const record = world.journal.recordAttempt.bind(world.journal);
          (world.journal as { recordAttempt: typeof record }).recordAttempt = async (entry) => {
            journalRefusals += 1;
            if (journalRefusals < 1000) throw new SigningJournalError("the ledger is throttling", "definite");
            return record(entry);
          };
        },
      },
    ];
    for (const item of cases) {
      const key = { mode: "ok", signs: 0 };
      const world = queuedWorld({
        relayerTuning: { failureBudget: 2 },
        wrapRelayerKey: (inner: DigestSigner): DigestSigner => ({
          ...inner,
          async sign(bytes) {
            key.signs += 1;
            if (key.mode === "unavailable") throw new SignerError("unavailable", "KMS: no answer within 3 s");
            if (key.mode === "socket") throw new Error("socket hang up");
            return inner.sign(bytes);
          },
        }),
      });
      await pendingStart(world);
      item.arrange(world, key);
      for (let round = 0; round < 6; round += 1) {
        await world.relayer.pass();
        world.clock.now += 700_000;
      }
      const start = await startOf(world);
      assert.equal(start.retry.failures, 0, `${item.name}: no intent budget spent`);
      assert.equal(start.status, "pending", `${item.name}: never held`);
      assert.deepEqual(world.chain.broadcasts, [], `${item.name}: nothing broadcast`);
    }
  });

  test("review M2: the intent store refusing the new attempt's write is operational -- backoff (no re-sign every pass), no intent budget, never a hold", async () => {
    let signs = 0;
    const world = queuedWorld({
      wrapRelayerKey: (inner: DigestSigner): DigestSigner => ({
        ...inner,
        async sign(bytes) {
          signs += 1;
          return inner.sign(bytes);
        },
      }),
    });
    await pendingStart(world);
    await world.restart();
    world.store.failNext.push("definite");
    await world.relayer.pass();
    assert.equal(signs, 1);
    assert.equal(world.relayer.status().troubled, 1);
    world.store.failNext.push("definite", "definite");
    await world.relayer.pass();
    await world.relayer.pass();
    assert.equal(signs, 1, "backing off: not signed again on the next passes");
    const start = await startOf(world);
    assert.deepEqual([start.retry.failures, start.status, start.attempts.length], [0, "pending", 0]);
    world.store.failNext.length = 0;
    await world.drive(started(world));
  });

  test("the backoff gates only the admission and the signature: a backing-off intent the chain makes moot is superseded at the next pass", async () => {
    const world = queuedWorld();
    await pendingStart(world);
    await world.restart();
    world.store.failNext.push("definite");
    await world.relayer.pass(); // journalled, the store refused: backing off
    assert.equal(world.relayer.status().troubled, 1);
    assert.ok(world.chain.withdraw("1", WALLETS[1]).ok); // a seat withdrew: the frozen roster can never start
    await world.relayer.pass(); // inside the backoff
    assert.equal((await startOf(world)).status, "superseded", "resolved from the chain at once");
    assert.equal(world.relayer.status().troubled, 0);
  });

  test("the ledger refusing: the intent backs off in memory -- the key is not asked to sign again every pass", async () => {
    let signs = 0;
    const world = queuedWorld({
      wrapRelayerKey: (inner: DigestSigner): DigestSigner => ({
        ...inner,
        async sign(bytes) {
          signs += 1;
          return inner.sign(bytes);
        },
      }),
    });
    await pendingStart(world);
    const record = world.journal.recordAttempt.bind(world.journal);
    let refusing = true;
    (world.journal as { recordAttempt: typeof record }).recordAttempt = async (entry) => {
      if (refusing) throw new SigningJournalError("the ledger is throttling", "definite");
      return record(entry);
    };
    await world.relayer.pass();
    assert.equal(signs, 1);
    await world.relayer.pass();
    await world.relayer.pass();
    assert.equal(signs, 1, "backing off: no re-sign on the immediate next passes");
    refusing = false;
    await world.drive(started(world));
    assert.equal(world.relayer.status().troubled, 0);
  });
});

/* ==================================================================
    §4 F-L5-16: WAIT + PAGE
   ================================================================== */

describe("§4 F-L5-16 wait + page", () => {
  test("an intent for an escrow this relayer does not serve: skipped in memory -- never held, nothing written -- and PAGED once", async () => {
    const world = queuedWorld();
    await pendingStart(world);
    const before = JSON.stringify(await startOf(world));
    world.pin = { ...PIN, contract_address: WALLETS[2] };
    await world.restart();
    await world.relayer.pass();
    await world.relayer.pass();
    assert.equal(JSON.stringify(await startOf(world)), before, "nothing written for it");
    const pages = opsOf(world, "chain.relayer-page").filter((line) => line.condition === "deployment-unavailable");
    assert.equal(pages.length, 1, "one page (preflight §19: any)");
    assert.equal(world.relayer.status().paging.paged, 1);
    assert.equal(opsOf(world, "chain.intent-held").length, 0);
  });

  test("review L1: a task that does not hold the relayer role pages nothing at its load; the role holder's first pass does", async () => {
    const role = { current: false };
    const world = queuedWorld({ relayerSeam: () => ({ authority: { current: () => role.current, beforeSideEffect: async () => undefined } }) });
    await pendingStart(world);
    world.pin = { ...PIN, contract_address: WALLETS[2] };
    await world.restart();
    assert.equal(opsOf(world, "chain.relayer-page").length, 0, "not the role holder: silent");
    assert.equal(world.relayer.status().paging.waiting, 1, "the condition is kept");
    role.current = true;
    await world.relayer.pass();
    assert.equal(opsOf(world, "chain.relayer-page").filter((line) => line.condition === "deployment-unavailable").length, 1);
  });

  test("a verdict that stays uncomputable waits (undecided, nothing written) and pages only after the threshold; it clears when the facts read again", async () => {
    const world = queuedWorld({ relayerTuning: { pageAfterMs: 300_000 } });
    await pendingStart(world);
    world.logFaults.add(GAME_A);
    await world.restart();
    assert.equal(world.relayer.status().undecided, 1);
    for (let round = 0; round < 4; round += 1) {
      world.clock.now += 60_000;
      await world.relayer.pass();
    }
    assert.equal(opsOf(world, "chain.relayer-page").length, 0, "not before five minutes");
    world.clock.now += 60_000;
    await world.relayer.pass();
    const pages = opsOf(world, "chain.relayer-page").filter((line) => line.condition === "verdict-undecided");
    assert.equal(pages.length, 1);
    assert.equal((await startOf(world)).record_version, 1, "waited, nothing written");
    world.logFaults.delete(GAME_A);
    await world.drive(started(world));
    assert.equal(opsOf(world, "chain.relayer-page-cleared").filter((line) => line.condition === "verdict-undecided").length, 1);
    assert.equal(world.relayer.status().paging.waiting, 0);
  });

  test("passes that keep failing (the chain unreachable) sign nothing and page after the threshold; recovery clears it", async () => {
    const world = queuedWorld({ relayerTuning: { pageAfterMs: 300_000 } });
    await pendingStart(world);
    await world.restart();
    world.chain.unavailable = true;
    for (let round = 0; round < 7; round += 1) {
      await world.relayer.pass();
      world.clock.now += 60_000;
    }
    const pages = opsOf(world, "chain.relayer-page").filter((line) => line.condition === "pass-failing");
    assert.equal(pages.length, 1);
    assert.deepEqual(world.chain.broadcasts, []);
    world.chain.unavailable = false;
    await world.drive(started(world));
    assert.equal(opsOf(world, "chain.relayer-page-cleared").filter((line) => line.condition === "pass-failing").length, 1);
  });
});

/* ==================================================================
    §5 PROCESS (NO QUEUE): UNCHANGED
   ================================================================== */

describe("§5 PROCESS mode (the file stores keep no queue): the load is LIVE-5's", () => {
  test("every game listed, every journalled attempt read (allAttempts), never the bounded read; the Start lands", async () => {
    const spy = spyJournal();
    const store = createMemoryChainIntentStore();
    const world = makeWorld({ intents: store, journal: spy.journal });
    await pendingStart(world);
    await world.restart();
    assert.equal(world.relayer.status().discovery, "games");
    assert.ok(store.reads.games >= 1 && store.reads.listGame >= 1);
    assert.equal(spy.calls.allAttempts, 1);
    assert.deepEqual(spy.calls.attemptsFrom, []);
    await world.drive(started(world));
  });
});

/* ==================================================================
    §6 THE ESCROW LOAD AND CHAIN SWEEP VISIT THE OPEN MONEY GAMES ONLY
   ================================================================== */

describe("§6 the escrow load over the open money games", () => {
  test("closed and cancelled money games are never read by the load or the sweep; every open one (funding, started, held) still is", async () => {
    const financial = createMemoryFinancialGameStore();
    const reads: string[] = [];
    const load = financial.load.bind(financial);
    financial.load = async (gameId) => {
      reads.push(gameId);
      return load(gameId);
    };
    /* 150 cancelled money games (history). */
    const cancelled: string[] = [];
    for (let n = 0; n < 150; n += 1) {
      const gameId = gameIdOf(20_000 + n);
      const record = newFinancialRecord(gameId, currentMoneyContinuation(), T0, PIN);
      const moved = transitionFinancial(record, { kind: "cancel-before-deal", at: T0 + 1 });
      assert.equal(moved.kind, "moved");
      financial.records.set(gameId, (moved as { next: typeof record }).next);
      cancelled.push(gameId);
    }
    const open = async () => {
      const out: string[] = [];
      for (const [gameId, record] of financial.records) if (typeof record === "string" || (record.phase !== "closed" && record.phase !== "cancelled")) out.push(gameId);
      return out.sort();
    };
    const world = makeWorld({ financial, openGames: open });
    await startedGame(world, GAME_A); // a started (in-progress) game
    await pendingStart(world, GAME_B); // a funding game with its Start pending
    await world.restart(); // (the world's restart also runs PROCESS mode's roster preload; AWS runs none)
    await world.service.idle();
    reads.length = 0;
    const loaded = await world.service.load();
    assert.equal(loaded.games, 2, "both open games visited");
    assert.equal(reads.filter((gameId) => cancelled.includes(gameId)).length, 0, "no cancelled game read by the load");
    reads.length = 0;
    await world.service.sweepChain();
    await world.service.idle();
    assert.equal(reads.filter((gameId) => cancelled.includes(gameId)).length, 0, "nor by the chain sweep");
    assert.ok(reads.includes(GAME_A) && reads.includes(GAME_B));
    await world.drive(started(world, GAME_B));
  });
});
