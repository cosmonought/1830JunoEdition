// server/src/rooms/gameActor.test.ts
//
// LIVE-3A: the per-game actor and the durable-before-visible commit pipeline, against the real server, the real
// `RoomSession` and real sockets, over a store the test controls. Run with `npm test` in server/ (after
// `npm run build`). The numbered cases are the LIVE-3A brief's mandatory list; P1/P2/P2b/P4 are LIVE-3 Appendix
// A's reproductions, as regressions.
//
// LIVE-2D: every game here is server-owned (a GameRecord seating ALICE and BOB, `testSupport.seedGame`), and a client
// never deals -- the server does, at `start-game`, and a client's `SetupGame` is refused. So each case starts from a
// game whose deal is already durable, and the move it holds, fails or races is the first PURCHASE (index 1) where it
// used to be a client's deal (index 0). The room-document cases (23, 26) are deleted with the room document; 24's
// question -- is a queued submit judged under the room state its predecessor committed -- is asked of the GameRecord.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createFileLogStore, type LogStore } from "../fileLogStore";
import { COMMITTED, type StoreWriteOutcome } from "../persistence/storeResult";
import { stripStoreMetadata } from "../persistence/logFormat";
import { RoomEngine } from "../../../frontend/src/gameEngine/replayLog";
import { stateDigest } from "../../../frontend/src/gameEngine";
import {
  ACTOR_QUEUE_BOUND,
  GameActor,
  newActorCounters,
  type GameStorePort,
  type RunResult,
  type TaskOrigin,
} from "./gameActor";
import { GameRegistry } from "./gameRegistry";
import type { GameRecord } from "./gameRecord";
import { createMemoryRecordStore, type RecordStore } from "./recordStore";
import {
  ALICE,
  BOB,
  BUILD,
  BUY,
  CAROL,
  Client,
  PASS,
  SETUP,
  controlledStore,
  devPrincipal,
  probeSession,
  quietConsole,
  seedGame,
  sleep,
  startServer,
  stopServer,
  storedLog,
  until,
  type Frame,
  type SeenEntry,
} from "./testSupport";

quietConsole();

/** LIVE-2D: a dealt, server-owned game -- Alice (host, on turn) and Bob seated, the deal and `buys` purchases already
 *  durable in `control` -- and the record store a server must be started with to find it. */
async function dealtGame(control: ReturnType<typeof controlledStore>, buys = 0) {
  const records = createMemoryRecordStore();
  const gameId = await seedGame(records, [ALICE, BOB], { dealt: true });
  control.logs.set(gameId, storedLog(buys));
  return { records, gameId };
}

const indexesOf = (frame: Frame): number[] => ((frame.entries as SeenEntry[]) ?? []).map((entry) => entry.index);

/** A client handed each index at most once, contiguously from 0, and exactly what the store holds there. */
function assertCoherent(client: Client, stored: readonly { index: number; id: string }[], label: string): void {
  const byIndex = new Map<number, string>();
  for (const entry of client.seen()) {
    const had = byIndex.get(entry.index);
    assert.ok(had === undefined || had === entry.id, `${label}: two different entries at index ${entry.index}`);
    byIndex.set(entry.index, entry.id);
    assert.equal(stored[entry.index]?.id, entry.id, `${label}: index ${entry.index} is not what the store holds`);
  }
}

/* ==================================================================
    THE EXECUTOR ITSELF (E-1, E-6, E-7, E-8, E-9), with synthetic tasks
   ================================================================== */
describe("the executor", () => {
  function unitActor() {
    let clock = 0;
    const counters = newActorCounters();
    const port: GameStorePort = {
      loadLog: async () => [],
      appendBatch: async () => COMMITTED,
      loadRecord: async () => null,
      saveRecord: async () => COMMITTED,
    };
    const actor = new GameActor({
      gameId: "UNIT",
      build: BUILD,
      explainDivergence: false,
      store: port,
      newSession: () => probeSession("unit"),
      restore: (session, entries) => session.restore(entries),
      now: () => clock,
      warn: () => undefined,
      counters,
    });
    return { actor, counters, advance: (ms: number) => (clock += ms) };
  }
  const originOf = (key: object, open = { value: true }): TaskOrigin => ({
    key,
    principal: "p-unit",
    isOpen: () => open.value,
    send: () => undefined,
  });
  /** A task that holds the actor until released. */
  const blocker = () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    return { op: () => gate, release: () => release() };
  };

  test("E-1: tasks run one at a time, in the order they were queued", async () => {
    const { actor } = unitActor();
    await actor.ready;
    const marks: string[] = [];
    const task = (name: string, ms: number) => async () => {
      marks.push(`start ${name}`);
      await sleep(ms);
      marks.push(`end ${name}`);
    };
    await Promise.all([actor.run("room-op", task("a", 15)), actor.run("room-op", task("b", 1)), actor.run("room-op", task("c", 5))]);
    assert.deepEqual(marks, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  test(`E-7: past ${ACTOR_QUEUE_BOUND} queued tasks the next is refused busy, and nothing is queued for it`, async () => {
    const { actor, counters } = unitActor();
    await actor.ready;
    const hold = blocker();
    const running = actor.run("room-op", hold.op);
    await sleep(1);
    let ran = 0;
    const queued = Array.from({ length: ACTOR_QUEUE_BOUND }, () => actor.run("room-op", () => void (ran += 1)));
    assert.equal(actor.queueDepth, ACTOR_QUEUE_BOUND);
    assert.deepEqual(await actor.run("room-op", () => void (ran += 1000)), { kind: "busy" });
    assert.equal(counters.busy, 1);
    hold.release();
    await running;
    await Promise.all(queued);
    assert.equal(ran, ACTOR_QUEUE_BOUND);
  });

  test("E-8: a queued task past its deadline is answered expired and never runs", async () => {
    const { actor, counters, advance } = unitActor();
    await actor.ready;
    const hold = blocker();
    const running = actor.run("room-op", hold.op);
    let ran = false;
    const late = actor.run("room-op", () => void (ran = true), { deadlineMs: 10 });
    advance(11);
    hold.release();
    await running;
    assert.deepEqual(await late, { kind: "expired", reason: "deadline" });
    assert.equal(ran, false);
    assert.equal(counters.expiredDeadline, 1);
  });

  test("E-8: a closed socket's queued tasks are cancelled at once and never run; its running task finishes", async () => {
    const { actor, counters } = unitActor();
    await actor.ready;
    const socket = {};
    const open = { value: true };
    const hold = blocker();
    let finished = false;
    const running = actor.run(
      "room-op",
      async () => {
        await hold.op();
        finished = true;
      },
      { origin: originOf(socket, open) },
    );
    await sleep(1);
    let ran = false;
    const queued = actor.run("room-op", () => void (ran = true), { origin: originOf(socket, open) });
    open.value = false;
    assert.equal(actor.cancelQueuedFrom(socket), 1);
    // Answered NOW -- before the running task has let go of the actor.
    assert.deepEqual(await queued, { kind: "expired", reason: "socket-closed" });
    hold.release();
    assert.deepEqual(await running, { kind: "ran", value: undefined });
    assert.equal(finished, true);
    assert.equal(ran, false);
    assert.equal(counters.expiredSocketClosed, 1);
    // A frame whose socket closed before it was queued is not queued at all.
    assert.deepEqual(await actor.run("room-op", () => void (ran = true), { origin: originOf({}, { value: false }) }), {
      kind: "expired",
      reason: "socket-closed",
    });
    assert.equal(ran, false);
  });

  test("E-9: a task that throws before its commit is rolled back to exactly the committed view", async () => {
    const { actor } = unitActor();
    await actor.ready;
    const thrown = await actor.run("submit", (tx) => {
      const answer = tx.session.submit({ actor: ALICE, build: BUILD, msg: SETUP as never, baseIndex: -1 });
      assert.equal(answer.kind, "applied");
      assert.equal(tx.session.entries.length, 1); // speculated privately...
      assert.equal(actor.view.watermark, -1); // ...and invisible
      throw new Error("boom");
    });
    assert.equal((thrown as RunResult<void>).kind, "failed");
    assert.equal(actor.view.watermark, -1);
    await actor.run("submit", (tx) => {
      assert.equal(tx.session.entries.length, 0); // the next task starts from the committed view
    });
  });

  test("E-6 / E-13: a task commits at most once, and its committed batch stands whatever it does next", async () => {
    const { actor } = unitActor();
    await actor.ready;
    const result = await actor.run("submit", async (tx) => {
      tx.session.submit({ actor: ALICE, build: BUILD, msg: SETUP as never, baseIndex: -1 });
      const batch = tx.session.entries.slice(0);
      const settled = await tx.commitBatch(batch, () => ({}));
      assert.equal(settled.kind, "committed");
      await tx.commitBatch(batch, () => ({})); // throws: E-6
    });
    assert.equal(result.kind, "failed");
    assert.equal(actor.view.watermark, 0); // committed, published, and never rolled back
  });
});

/* ==================================================================
    THE REGISTRY (E-12): single-flight, and eviction only when idle
   ================================================================== */
describe("the registry", () => {
  test("concurrent first touches share one actor and one load; idle actors are evicted, busy ones are not", async () => {
    let loads = 0;
    let clock = 0;
    const counters = newActorCounters();
    const registry = new GameRegistry({
      evictable: true,
      now: () => clock,
      idleMs: 100,
      sweepMs: 1_000_000,
      create: (gameId) =>
        new GameActor({
          gameId,
          build: BUILD,
          explainDivergence: false,
          store: {
            loadLog: async () => {
              loads += 1;
              await sleep(20);
              return [];
            },
            appendBatch: async () => COMMITTED,
            loadRecord: async () => null,
            saveRecord: async () => COMMITTED,
          },
          newSession: () => probeSession("reg"),
          restore: (session, entries) => session.restore(entries),
          now: () => clock,
          warn: () => undefined,
          counters,
        }),
    });
    const [a, b, c] = await Promise.all([registry.get("G"), registry.get("G"), registry.get("G")]);
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(loads, 1);
    assert.equal(registry.created, 1);
    const key = {};
    a.subscribe(key, { principal: ALICE, isOpen: () => true, send: () => undefined }, -1);
    clock += 1_000;
    assert.deepEqual(registry.evictIdle(clock), []); // subscribed: not idle, however long ago it last acted
    a.unsubscribe(key);
    assert.deepEqual(registry.evictIdle(clock + 50), []); // idle, but not for long enough
    clock += 1_000;
    assert.deepEqual(registry.evictIdle(clock), ["G"]);
    assert.equal(registry.peek("G"), undefined);
    await registry.get("G"); // a fresh actor, loaded from the store
    assert.equal(loads, 2);
    registry.close();
  });
});

/* ==================================================================
    THE PIPELINE, OVER REAL SOCKETS
   ================================================================== */
describe("durable before visible", () => {
  test("P1 (1, 2, 3, 4): a later submit cannot run before an earlier append resolves, and a hello sees only the committed prefix", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    control.control.holdAppends = true;
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      assert.deepEqual((await alice.next((f) => f.kind === "catch-up")).inFlight, []);
      alice.submit(BUY, { baseIndex: 0, submissionId: "a-buy" });
      const purchase = await control.nextHeldAppend();

      // 4: Bob's hello while the purchase awaits the disk sees the committed prefix -- the deal -- not the purchase.
      const bob = await Client.open(port, BOB);
      bob.hello(gameId);
      assert.deepEqual(indexesOf(await bob.next((f) => f.kind === "catch-up")), [0]);

      // 2: Alice's second tab submits a move that only makes sense on top of the pending purchase.
      const tab = await Client.open(port, ALICE);
      tab.hello(gameId);
      await tab.next((f) => f.kind === "catch-up");
      tab.submit(BUY, { baseIndex: 1, submissionId: "a2-buy" });
      await sleep(30);
      // 1, 3: it has not run -- the store has seen exactly one append, and nothing was answered.
      assert.equal(control.calls.appendLog, 1);
      assert.equal(tab.of("refused").length + tab.of("applied").length, 0);

      // The purchase's append fails, and nothing of it is anywhere.
      purchase.fail(false);
      const buyAnswer = await alice.answerTo("a-buy");
      assert.deepEqual([buyAnswer.kind, buyAnswer.code], ["refused", "retry"]);
      // The queued move is judged only now, against the durable history it never saw: `ahead`.
      const tabAnswer = await tab.answerTo("a2-buy");
      assert.deepEqual([tabAnswer.kind, tabAnswer.code, tabAnswer.watermark], ["refused", "ahead", 0]);
      assert.deepEqual(control.indices(gameId), [0]);
      assert.equal(bob.of("applied").length, 0);
      assert.equal(server.counters.submitAhead, 1);

      // A fresh hello agrees: the game holds its deal and nothing more.
      const carol = await Client.open(port, CAROL);
      carol.hello(gameId);
      assert.deepEqual(indexesOf(await carol.next((f) => f.kind === "catch-up")), [0]);
      await Promise.all([alice.close(), bob.close(), tab.close(), carol.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("P1, committed (5, 25): the queued move runs on the committed one; fan-out follows commit order with no gap or repeat", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    control.control.holdAppends = true;
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const alice = await Client.open(port, ALICE);
      const bob = await Client.open(port, BOB);
      const watcher = await Client.open(port, CAROL);
      for (const client of [alice, bob, watcher]) {
        client.hello(gameId);
        await client.next((f) => f.kind === "catch-up");
      }
      alice.submit(BUY, { baseIndex: 0, submissionId: "a-buy" });
      const first = await control.nextHeldAppend();
      bob.submit(BUY, { baseIndex: 1, submissionId: "b-buy" });
      await sleep(20);
      first.release();
      assert.equal((await alice.answerTo("a-buy")).kind, "applied");
      const second = await control.nextHeldAppend(); // the queued move ran only now, on the committed purchase
      assert.equal(second.entries[0].index, 2);
      second.release();
      assert.equal((await bob.answerTo("b-buy")).kind, "applied");

      // A late joiner sees both in its catch-up, and no fan-out of either.
      const late = await Client.open(port, "p-late");
      late.hello(gameId);
      assert.deepEqual(indexesOf(await late.next((f) => f.kind === "catch-up")), [0, 1, 2]);
      await sleep(20);
      assert.equal(late.of("applied").length, 0);

      // The watcher subscribed before either publish: exactly one fan-out of each, in commit order, never a direct answer.
      const watched = watcher.of("applied");
      assert.deepEqual(watched.map((f) => (f.entries as SeenEntry[])[0].index), [1, 2]);
      assert.ok(watched.every((f) => f.inReplyTo === undefined));
      for (const client of [alice, bob, watcher, late]) assertCoherent(client, control.log(gameId), client.claim);
      assert.deepEqual(control.indices(gameId), [0, 1, 2]);
      await Promise.all([alice.close(), bob.close(), watcher.close(), late.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("P2 (6, 7): two first-touch hellos after a restart load one actor; no acknowledged index disappears or repeats", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    control.control.loadDelayMs = 30;
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const alice = await Client.open(port, ALICE);
      const bob = await Client.open(port, BOB);
      alice.hello(gameId);
      bob.hello(gameId); // both first touches, inside the same slow load
      const [a, b] = await Promise.all([alice.next((f) => f.kind === "catch-up"), bob.next((f) => f.kind === "catch-up")]);
      assert.equal(control.calls.loadLog, 1);
      assert.deepEqual(a.entries, b.entries);
      const deal = (a.entries as SeenEntry[])[0];

      alice.submit(BUY, { baseIndex: 0, baseId: deal.id, submissionId: "a-buy" });
      const bought = await alice.answerTo("a-buy");
      assert.equal(bought.kind, "applied");
      // Both subscribers are on the one actor: Bob hears it.
      const heard = await bob.next((f) => f.kind === "applied");
      assert.deepEqual(indexesOf(heard), [1]);

      const carol = await Client.open(port, CAROL);
      carol.hello(gameId);
      assert.deepEqual(indexesOf(await carol.next((f) => f.kind === "catch-up")), [0, 1]);

      const first = (heard.entries as SeenEntry[])[0];
      bob.submit(BUY, { baseIndex: 1, baseId: first.id, submissionId: "b-buy" });
      assert.equal((await bob.answerTo("b-buy")).kind, "applied");
      assert.deepEqual(control.indices(gameId), [0, 1, 2]);
      assert.equal(control.calls.loadLog, 1);
      await Promise.all([alice.close(), bob.close(), carol.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("P2b (8): a delayed append cannot be overtaken -- the file holds 0,1,2 and a restart mints 3", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live3a-p2b-"));
    const file = createFileLogStore(directory);
    const records = createMemoryRecordStore();
    const gameId = await seedGame(records, [ALICE, BOB], { dealt: true });
    assert.equal((await file.appendBatch(gameId, storedLog(0))).kind, "committed"); // the deal, durable before the start
    let delayNext = false;
    // LIVE-3B: the server asks the classified `appendBatch` when a store has it, so that is what is delayed.
    const store: LogStore = {
      ...file,
      appendBatch: async (room, entries) => {
        if (delayNext) {
          delayNext = false;
          await sleep(40);
        }
        return file.appendBatch(room, entries);
      },
    };
    const lines = () =>
      fs
        .readFileSync(path.join(directory, `${gameId}.log.jsonl`), "utf8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as SeenEntry).index);
    try {
      const { server, port } = await startServer({ store, records });
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");

      delayNext = true;
      alice.submit(BUY, { baseIndex: 0, submissionId: "a-buy" });
      await sleep(10);
      // Bob's hello lands inside Alice's delayed append: he sees only the durable deal.
      const bob = await Client.open(port, BOB);
      bob.hello(gameId);
      assert.deepEqual(indexesOf(await bob.next((f) => f.kind === "catch-up")), [0]);
      // Bob's move for index 2 waits for Alice's append to resolve; it cannot be written first.
      bob.submit(BUY, { baseIndex: 1, submissionId: "b-buy" });
      assert.equal((await alice.answerTo("a-buy")).kind, "applied");
      assert.equal((await bob.answerTo("b-buy")).kind, "applied");
      assert.deepEqual(lines(), [0, 1, 2]);
      await Promise.all([alice.close(), bob.close()]);
      await stopServer(server);

      const restarted = await startServer({ store: createFileLogStore(directory), records });
      const carol = await Client.open(restarted.port, ALICE);
      carol.hello(gameId);
      assert.deepEqual(indexesOf(await carol.next((f) => f.kind === "catch-up")), [0, 1, 2]);
      carol.submit(BUY, { baseIndex: 2, submissionId: "c-buy" });
      const next = await carol.answerTo("c-buy");
      assert.equal(next.kind, "applied");
      assert.equal((next.entries as SeenEntry[])[0].index, 3);
      assert.deepEqual(lines(), [0, 1, 2, 3]);
      await carol.close();
      await stopServer(restarted.server);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("two-sided baseIndex, the anchor, and replies that name their submission", () => {
  test("9-15, 27: stale, eligible, ahead, a wrong anchor, a duplicate nonce, and a client without an anchor", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control, 1); // [deal, alice's buy]: watermark 1, Bob on turn
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const alice = await Client.open(port, ALICE);
      const bob = await Client.open(port, BOB);
      alice.hello(gameId);
      bob.hello(gameId);
      const history = (await alice.next((f) => f.kind === "catch-up")).entries as SeenEntry[];
      await bob.next((f) => f.kind === "catch-up");

      // 9: below the watermark is stale -- a catch-up naming the submission.
      bob.submit(BUY, { baseIndex: 0, baseId: history[0].id, submissionId: "b-stale" });
      const stale = await bob.answerTo("b-stale");
      assert.equal(stale.kind, "catch-up");
      assert.deepEqual(indexesOf(stale), [1]);

      // 11: above it is `ahead`, with the watermark, and nothing is run.
      bob.submit(BUY, { baseIndex: 9, submissionId: "b-ahead" });
      const ahead = await bob.answerTo("b-ahead");
      assert.deepEqual([ahead.kind, ahead.code, ahead.watermark], ["refused", "ahead", 1]);

      // 12: at the watermark but anchored to an entry the room does not hold: `resync`, nothing run.
      bob.submit(BUY, { baseIndex: 1, baseId: "not-this-rooms", submissionId: "b-anchor" });
      const anchor = await bob.answerTo("b-anchor");
      assert.deepEqual([anchor.kind, anchor.code], ["refused", "resync"]);
      assert.deepEqual(control.indices(gameId), [0, 1]);

      // 10, 14: equal is eligible, and the answer names the submission it answers.
      bob.submit(BUY, { baseIndex: 1, baseId: history[1].id, submissionId: "b-buy" });
      const bought = await bob.answerTo("b-buy");
      assert.equal(bought.kind, "applied");
      assert.equal((bought.entries as SeenEntry[])[0].index, 2);
      // 15: Alice gets the same news as a fan-out, which names no submission.
      const fanned = await alice.next((f) => f.kind === "applied");
      assert.equal(fanned.inReplyTo, undefined);

      // 13: a duplicate nonce -- even sent from behind -- is a catch-up containing the submitter's own entry.
      bob.submit(BUY, { baseIndex: 0, submissionId: "b-buy" });
      const duplicate = await bob.answerTo("b-buy");
      assert.equal(duplicate.kind, "catch-up");
      assert.ok((duplicate.entries as SeenEntry[]).some((e) => e.submission_id === "b-buy" && e.index === 2));
      assert.deepEqual(control.indices(gameId), [0, 1, 2]);

      // 27: a client that sends no anchor gets the index-only rules, on hello and submit alike.
      const unanchored = await Client.open(port, ALICE);
      unanchored.hello(gameId, 1);
      assert.deepEqual(indexesOf(await unanchored.next((f) => f.kind === "catch-up")), [2]);
      unanchored.submit(BUY, { baseIndex: 2, submissionId: "unanchored-buy" });
      assert.equal((await unanchored.answerTo("unanchored-buy")).kind, "applied");

      assert.equal(server.counters.submitAhead, 1);
      assert.equal(server.counters.submitResync, 1);
      await Promise.all([alice.close(), bob.close(), unanchored.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("12: a hello ahead of the room, or anchored to another history, is told `resync` and not subscribed", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control, 1);
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const ahead = await Client.open(port, BOB);
      ahead.hello(gameId, 5);
      const refused = await ahead.next((f) => f.kind === "error");
      assert.deepEqual([refused.code, refused.watermark], ["resync", 1]);
      const forked = await Client.open(port, BOB);
      forked.hello(gameId, 1, "some-other-history");
      assert.equal((await forked.next((f) => f.kind === "error")).code, "resync");
      assert.equal(server.counters.helloResync, 2);

      // Neither is subscribed: a move now reaches neither. Re-joining from -1 is the way back.
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      const log = control.log(gameId);
      const bob = await Client.open(port, BOB);
      bob.hello(gameId, 1, log[1].id);
      await bob.next((f) => f.kind === "catch-up");
      bob.submit(BUY, { baseIndex: 1, baseId: log[1].id, submissionId: "b-buy" });
      assert.equal((await bob.answerTo("b-buy")).kind, "applied");
      await alice.next((f) => f.kind === "applied");
      await sleep(20);
      assert.equal(ahead.of("applied").length + forked.of("applied").length, 0);
      forked.hello(gameId, -1);
      assert.equal(((await forked.next((f) => f.kind === "catch-up")).entries as SeenEntry[]).length, 3);
      await Promise.all([ahead.close(), forked.close(), alice.close(), bob.close()]);
    } finally {
      await stopServer(server);
    }
  });
});

describe("sockets that go away (E-8, §4.2)", () => {
  test("16: a submit queued when its socket closes is cancelled and never runs", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    control.control.holdAppends = true;
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(BUY, { baseIndex: 0, submissionId: "a-buy" });
      const purchase = await control.nextHeldAppend();
      const tab = await Client.open(port, ALICE);
      tab.hello(gameId);
      await tab.next((f) => f.kind === "catch-up");
      tab.submit(BUY, { baseIndex: 1, submissionId: "queued-buy" });
      await sleep(20);
      await tab.close();
      await until(() => server.counters.expiredSocketClosed === 1, "the queued task's cancellation");
      purchase.release();
      assert.equal((await alice.answerTo("a-buy")).kind, "applied");
      await sleep(30);
      assert.equal(control.calls.appendLog, 1); // the cancelled buy never reached the store
      assert.deepEqual(control.indices(gameId), [0, 1]);
      await alice.close();
    } finally {
      await stopServer(server);
    }
  });

  test("17, 18: a submit RUNNING when its socket closes still commits; a reconnect sees it in `inFlight` until it lands", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    control.control.holdAppends = true;
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const bob = await Client.open(port, BOB);
      bob.hello(gameId);
      await bob.next((f) => f.kind === "catch-up");
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(BUY, { baseIndex: 0, submissionId: "buy-x" });
      const purchase = await control.nextHeldAppend();
      await alice.close(); // gone while its commit is in flight

      // 18: the reconnecting tab is told the move is still being committed -- not lost.
      const again = await Client.open(port, ALICE);
      again.hello(gameId);
      const hello = await again.next((f) => f.kind === "catch-up");
      assert.deepEqual(indexesOf(hello), [0]);
      assert.deepEqual(hello.inFlight, ["buy-x"]);

      // 17: it commits, and both the watcher and the reconnected tab hear it as history.
      purchase.release();
      const landed = await again.next((f) => f.kind === "applied");
      assert.equal(landed.inReplyTo, undefined);
      assert.equal((landed.entries as SeenEntry[])[0].submission_id, "buy-x");
      await bob.next((f) => f.kind === "applied");
      await sleep(20);
      assert.equal(again.of("abandoned").length, 0);
      assert.deepEqual(control.indices(gameId), [0, 1]);
      await Promise.all([bob.close(), again.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("19: a running orphan that ends without committing is `abandoned` to its player's current sockets", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    control.control.holdAppends = true;
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(BUY, { baseIndex: 0, submissionId: "buy-y" });
      const purchase = await control.nextHeldAppend();
      await alice.close();
      const again = await Client.open(port, ALICE);
      again.hello(gameId);
      assert.deepEqual((await again.next((f) => f.kind === "catch-up")).inFlight, ["buy-y"]);
      const bob = await Client.open(port, BOB); // not Alice: never told about her submission
      bob.hello(gameId);
      await bob.next((f) => f.kind === "catch-up");
      purchase.fail(false);
      const abandoned = await again.next((f) => f.kind === "abandoned");
      assert.equal(abandoned.inReplyTo, "buy-y");
      await sleep(20);
      assert.equal(bob.of("abandoned").length, 0);
      assert.deepEqual(control.indices(gameId), [0]);
      await Promise.all([again.close(), bob.close()]);
    } finally {
      await stopServer(server);
    }
  });
});

describe("a reconnect that overtakes its old socket's close (half-open)", () => {
  /* The close of the old socket arrives on the old connection and the reconnecting hello on a new one; nothing
     orders the two, and a half-open socket may not be seen to close for a minute. Its QUEUED submission can then
     still run -- so the hello reports it in flight, and it is settled for the new socket either way. */
  for (const ending of ["lands", "is refused"] as const) {
    test(`a submission still QUEUED behind another's append is reported in \`inFlight\`, and ${ending === "lands" ? "its landing" : "`abandoned`"} settles it`, async () => {
      const control = controlledStore();
      const { records, gameId } = await dealtGame(control, 1); // [deal, Alice's buy]: Bob is on turn
      control.control.holdAppends = true;
      const { server, port } = await startServer({ store: control.store, records });
      try {
        const last = control.log(gameId)[1];
        const bob = await Client.open(port, BOB);
        bob.hello(gameId, 1, last.id);
        await bob.next((f) => f.kind === "catch-up");
        // Bob's purchase holds the actor while its append awaits the disk.
        bob.submit(BUY, { baseIndex: 1, baseId: last.id, submissionId: "b-hold" });
        const held = await control.nextHeldAppend();
        // Alice's old socket queues a move behind it, for the board after Bob's purchase...
        const old = await Client.open(port, ALICE);
        old.hello(gameId, 1, last.id);
        await old.next((f) => f.kind === "catch-up");
        // Refused when it runs: the auction still has privates for sale (#1249).
        const move = ending === "lands" ? BUY : { OpenStockRound: {} };
        old.submit(move, { baseIndex: 2, submissionId: "a-queued" });
        await sleep(20);
        // ...and her reconnect is heard before that socket is seen to close.
        const fresh = await Client.open(port, ALICE);
        fresh.hello(gameId, 1, last.id);
        const hello = await fresh.next((f) => f.kind === "catch-up");
        assert.deepEqual(hello.inFlight, ["a-queued"]);
        held.release();
        if (ending === "lands") {
          const buy = await control.nextHeldAppend();
          buy.release();
          const landed = await fresh.next((f) => f.kind === "applied" && (f.entries as SeenEntry[]).some((e) => e.submission_id === "a-queued"));
          assert.equal(landed.inReplyTo, undefined);
          await sleep(20);
          assert.equal(fresh.of("abandoned").length, 0);
        } else {
          const abandoned = await fresh.next((f) => f.kind === "abandoned");
          assert.equal(abandoned.inReplyTo, "a-queued");
          assert.equal((await old.answerTo("a-queued")).kind, "refused"); // its own socket got the refusal
        }
        await Promise.all([bob.close(), old.close(), fresh.close()]);
      } finally {
        await stopServer(server);
      }
    });
  }
});

describe("the point of no return (E-9, E-13)", () => {
  test("20, 21 (F-13): a reducer that throws after the push is rolled back -- refused, and stored and sent nowhere", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    const { server, port } = await startServer({ store: control.store, records });
    const original = RoomEngine.prototype.submit;
    /* Armed only once the game has loaded: the load replays the stored deal through the same engine. */
    let armed = false;
    RoomEngine.prototype.submit = function (this: RoomEngine, ...args: Parameters<typeof original>) {
      if (armed) {
        armed = false;
        throw new Error("injected reducer failure");
      }
      return original.apply(this, args);
    } as typeof original;
    try {
      const bob = await Client.open(port, BOB);
      bob.hello(gameId);
      await bob.next((f) => f.kind === "catch-up");
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      armed = true;
      alice.submit(BUY, { baseIndex: 0, submissionId: "buy-1" });
      const refused = await alice.answerTo("buy-1");
      assert.deepEqual([refused.kind, refused.code], ["refused", "internal"]);
      assert.match(String(refused.reason), /\(ref [A-Z0-9]{6}\)/);
      assert.ok(!String(refused.reason).includes("injected"), "the exception's own text is not echoed");
      await sleep(20);
      assert.equal(control.calls.appendLog, 0);
      assert.equal(bob.of("applied").length, 0);
      // Nothing it touched survived: the same submission is judged afresh and lands at index 1, not 2.
      alice.submit(BUY, { baseIndex: 0, submissionId: "buy-1" });
      const bought = await alice.answerTo("buy-1");
      assert.equal(bought.kind, "applied");
      assert.equal((bought.entries as SeenEntry[])[0].index, 1);
      assert.deepEqual(control.indices(gameId), [0, 1]);
      await Promise.all([alice.close(), bob.close()]);
    } finally {
      RoomEngine.prototype.submit = original;
      await stopServer(server);
    }
  });

  test("22 (E-13): a commit whose next view cannot be built is published from the store, and answered applied", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    let armed = false;
    const { server, port } = await startServer({
      store: control.store,
      records,
      faults: {
        beforeViewBuild: () => {
          if (armed) {
            armed = false;
            throw new Error("injected view-build failure");
          }
        },
      },
    });
    try {
      const bob = await Client.open(port, BOB);
      bob.hello(gameId);
      await bob.next((f) => f.kind === "catch-up");
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      armed = true;
      alice.submit(BUY, { baseIndex: 0, submissionId: "buy" });
      const answer = await alice.answerTo("buy");
      assert.equal(answer.kind, "applied");
      assert.equal((answer.entries as SeenEntry[])[0].index, 1);
      assert.equal(server.counters.viewRebuiltFromStore, 1);
      const heard = await bob.next((f) => f.kind === "applied");
      assert.equal(heard.digest, answer.digest);
      const carol = await Client.open(port, CAROL);
      carol.hello(gameId);
      assert.equal(((await carol.next((f) => f.kind === "catch-up")).entries as SeenEntry[]).length, 2);
      await Promise.all([alice.close(), bob.close(), carol.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("a rejected append that never landed is rolled back and answered retry; the nonce is judged afresh", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    control.control.failAppends.push({ landed: false });
    const { server, port } = await startServer({ store: control.store, records });
    try {
      const bob = await Client.open(port, BOB);
      bob.hello(gameId);
      await bob.next((f) => f.kind === "catch-up");
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(BUY, { baseIndex: 0, submissionId: "a1" });
      const failed = await alice.answerTo("a1");
      assert.deepEqual([failed.kind, failed.code], ["refused", "retry"]);
      await sleep(20);
      assert.equal(bob.of("applied").length, 0);
      alice.submit(BUY, { baseIndex: 0, submissionId: "a1" });
      assert.equal((await alice.answerTo("a1")).kind, "applied");
      assert.deepEqual(control.indices(gameId), [0, 1]);
      assert.equal(server.counters.storeAppendFailed, 1);
      await Promise.all([alice.close(), bob.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("21 (LIVE-3B): an append the store could not settle is `unavailable` and held for a restart -- never read back, never 'refused but stored'", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    // The bytes reached the file, then an error the store's own redo could not settle.
    control.control.failAppends.push({ landed: true });
    const restarts: string[] = [];
    const first = await startServer({ store: control.store, records, onRestartRequired: (room) => restarts.push(room) });
    try {
      const bob = await Client.open(first.port, BOB);
      bob.hello(gameId);
      await bob.next((f) => f.kind === "catch-up");
      const alice = await Client.open(first.port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(BUY, { baseIndex: 0, submissionId: "a1" });
      const unsure = await alice.answerTo("a1");
      assert.deepEqual([unsure.kind, unsure.code], ["refused", "unavailable"], "never `retry` for a move that may have landed");
      assert.equal((await bob.next((f) => f.kind === "status")).state, "unavailable");
      assert.deepEqual(restarts, [gameId]);
      assert.equal(first.server.counters.restartRequired, 1);

      // The store DOES show the entry, and the 3A rule would have adopted it by reading it back. 3B never reads.
      await sleep(1_200); // past the 3A read-back's first attempt (1 s)
      assert.deepEqual(control.indices(gameId), [0, 1]);
      assert.equal(control.calls.loadLog, 1, "no read-back after an uncertain write");
      assert.equal(first.server.counters.reconciled, 0);
      assert.equal(bob.of("applied").length, 0, "nothing the actor could not vouch for was sent");
      // While held, writes are refused and nothing reaches the store.
      alice.submit(PASS, { baseIndex: 0, submissionId: "while-held" });
      assert.equal((await alice.answerTo("while-held")).code, "unavailable");
      assert.equal(control.calls.appendLog, 1);
      await Promise.all([alice.close(), bob.close()]);
    } finally {
      await stopServer(first.server);
    }

    // The restart reads what the store really holds, and the nonce makes the retry a catch-up, not a second move.
    const second = await startServer({ store: control.store, records });
    try {
      const back = await Client.open(second.port, ALICE);
      back.hello(gameId);
      const hello = await back.next((f) => f.kind === "catch-up");
      assert.deepEqual((hello.entries as SeenEntry[]).map((e) => e.submission_id), ["stored-deal", "a1"]);
      back.submit(BUY, { baseIndex: 0, submissionId: "a1" });
      assert.equal((await back.answerTo("a1")).kind, "catch-up");
      assert.deepEqual(control.indices(gameId), [0, 1]);
      await back.close();
    } finally {
      await stopServer(second.server);
    }
  });
});

describe("E-11: a store call that does not answer in time (LIVE-3B)", () => {
  test("29, 30: a late append holds the game; the next task of that game does not run; when it lands it is adopted exactly once", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    control.control.holdAppends = true;
    const { server, port } = await startServer({ store: control.store, records, storeTimeoutMs: 60 });
    try {
      const bob = await Client.open(port, BOB);
      bob.hello(gameId);
      await bob.next((f) => f.kind === "catch-up");
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(BUY, { baseIndex: 0, submissionId: "a1" });
      const held = await control.nextHeldAppend();

      // Past the timeout: uncertain, not failed. The submitter is told `unavailable`, every subscriber is told.
      const unsure = await alice.answerTo("a1");
      assert.deepEqual([unsure.kind, unsure.code], ["refused", "unavailable"]);
      assert.equal((await bob.next((f) => f.kind === "status")).state, "unavailable");
      assert.equal(server.counters.storeTimeouts, 1);

      // The next task of this game queues behind the late call: it neither runs nor writes.
      bob.submit(BUY, { baseIndex: 0, submissionId: "b1" });
      await sleep(150);
      assert.equal(bob.frames.filter((f) => f.inReplyTo === "b1").length, 0, "the next task did not run");
      assert.equal(control.calls.appendLog, 1, "nothing was written behind the late call");
      // A reconnecting hello meanwhile is served the committed view and told the move is in flight.
      const tab = await Client.open(port, ALICE);
      tab.hello(gameId);
      const reconnect = await tab.next((f) => f.kind === "catch-up");
      assert.deepEqual([indexesOf(reconnect), reconnect.inFlight], [[0], ["a1"]]);

      // It lands: adopted once -- history to every subscriber, the submitter included -- and the hold lifts.
      held.release();
      for (const client of [alice, bob, tab]) {
        const landed = await client.next((f) => f.kind === "applied", `the late purchase for ${client.claim}`);
        assert.equal(landed.inReplyTo, undefined);
        assert.deepEqual((landed.entries as SeenEntry[]).map((e) => e.submission_id), ["a1"]);
      }
      assert.equal((await bob.next((f) => f.kind === "status")).state, "live");
      // Only now does the queued task run -- on the committed purchase (stale: it was sent from 0).
      const b1 = await bob.answerTo("b1");
      assert.equal(b1.kind, "catch-up");
      await sleep(30);
      for (const client of [alice, bob, tab]) {
        const purchases = client.seen().filter((e) => e.submission_id === "a1");
        assert.equal(new Set(purchases.map((e) => e.id)).size, 1, `${client.claim} was handed exactly one purchase`);
      }
      assert.equal(alice.of("abandoned").length + tab.of("abandoned").length, 0);
      assert.deepEqual(control.indices(gameId), [0, 1]);
      assert.equal(server.counters.lateAdopted, 1);
      assert.equal(server.counters.restartRequired, 0);
      await Promise.all([alice.close(), bob.close(), tab.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("30: a late append that then DEFINITELY fails is abandoned -- nothing stored, the hold lifts, the next move is judged afresh", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    control.control.holdAppends = true;
    const { server, port } = await startServer({ store: control.store, records, storeTimeoutMs: 40 });
    try {
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(BUY, { baseIndex: 0, submissionId: "a1" });
      const held = await control.nextHeldAppend();
      assert.equal((await alice.answerTo("a1")).code, "unavailable");
      held.fail(false);
      // The hold lifts, and the move that never landed is abandoned to the player who was told it was in flight.
      assert.equal((await alice.next((f) => f.kind === "status" && f.state === "live")).state, "live");
      const gone = await alice.next((f) => f.kind === "abandoned");
      assert.equal(gone.inReplyTo, "a1");
      assert.deepEqual(control.indices(gameId), [0]);
      control.control.holdAppends = false;
      alice.submit(BUY, { baseIndex: 0, submissionId: "a2" });
      assert.equal((await alice.answerTo("a2")).kind, "applied");
      assert.deepEqual(control.indices(gameId), [0, 1]);
      await alice.close();
    } finally {
      await stopServer(server);
    }
  });

  test("31: a late append that never settles keeps the game unavailable and asks for a restart", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    control.control.holdAppends = true;
    const restarts: string[] = [];
    const { server, port } = await startServer({
      store: control.store,
      records,
      storeTimeoutMs: 30,
      storeRestartAfterMs: 80,
      onRestartRequired: (room, detail) => restarts.push(`${room}: ${detail}`),
    });
    try {
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(BUY, { baseIndex: 0, submissionId: "a1" });
      await control.nextHeldAppend(); // never released
      assert.equal((await alice.answerTo("a1")).code, "unavailable");
      await until(() => restarts.length === 1, "the restart request");
      assert.match(restarts[0], /has still not settled/);
      // Still held: a hello is served the committed prefix and told it is unavailable; a move does not run.
      const carol = await Client.open(port, CAROL);
      carol.hello(gameId);
      assert.deepEqual(indexesOf(await carol.next((f) => f.kind === "catch-up")), [0]);
      assert.equal((await carol.next((f) => f.kind === "status")).state, "unavailable");
      alice.submit(PASS, { baseIndex: 0, submissionId: "after" });
      await sleep(60);
      assert.equal(alice.frames.filter((f) => f.inReplyTo === "after").length, 0);
      assert.equal(control.calls.appendLog, 1);
      assert.deepEqual(control.indices(gameId), [0]);
      await Promise.all([alice.close(), carol.close()]);
    } finally {
      await stopServer(server);
    }
  });
});

describe("room authority is serialized with the moves (§21 LIVE-3A, F-10)", () => {
  /** A record store whose puts the test can hold, then land or fail (definitely: nothing written). */
  function holdableRecords() {
    const inner = createMemoryRecordStore();
    const held: Array<{ release(): void; fail(): void }> = [];
    const control = { holding: false };
    const records: RecordStore = {
      ...inner,
      put: (record: GameRecord, expected: number | null): Promise<StoreWriteOutcome> =>
        control.holding
          ? new Promise((resolve) =>
              held.push({
                release: () => void inner.put(record, expected).then(resolve),
                fail: () => resolve({ kind: "definite", detail: "injected: the record write reached nothing" }),
              }),
            )
          : inner.put(record, expected),
    };
    return { records, inner, control, nextHeld: async () => (await until(() => held.length > 0, "a held record write"), held.shift() as (typeof held)[number]) };
  }

  /* LIVE-2D: cases 23 and 26 (a room DOCUMENT the store refused, or could not confirm) are deleted with the room
     document; the GameRecord's refused and unknown writes are LIVE-2C's (live2cRooms.test, `failPuts`). 24 is asked of
     the record: the authority a queued submit depends on is the SEAT, and a `release-seat` holding the actor at the
     record store decides it. */
  test("24: a submit queued behind a room operation is judged under the record that operation committed -- or not", async () => {
    for (const outcome of ["committed", "refused"] as const) {
      const control = controlledStore();
      const held = holdableRecords();
      const gameId = await seedGame(held.records, [ALICE, BOB]); // waiting: Bob may still give his seat up
      const { server, port } = await startServer({ store: control.store, records: held.records });
      try {
        const bob = await Client.open(port, BOB);
        bob.hello(gameId);
        await bob.next((f) => f.kind === "catch-up");
        held.control.holding = true;
        const release = bob.roomOp({ type: "release-seat" }, gameId);
        const write = await held.nextHeld();
        bob.submit(BUY, { baseIndex: -1, submissionId: "queued" });
        await sleep(30);
        assert.equal(bob.frames.filter((f) => f.inReplyTo === "queued").length, 0, "the submit waits behind the room operation");
        held.control.holding = false;
        if (outcome === "committed") write.release();
        else write.fail();
        const ack = await bob.ack(release);
        const answer = await bob.answerTo("queued");
        const stored = (await held.inner.load(gameId)) as GameRecord;
        if (outcome === "committed") {
          assert.equal(ack.ok, true);
          assert.deepEqual([answer.kind, answer.code], ["refused", "not-seated"], "judged under the committed record: Bob has no seat");
          assert.deepEqual(stored.seats.map((seat) => seat.principal_id), [devPrincipal(ALICE)]);
        } else {
          assert.equal(ack.code, "unavailable");
          assert.equal(answer.kind, "refused", "nothing is dealt, so the move is refused either way");
          assert.notEqual(answer.code, "not-seated", "the refused write left Bob his seat, and the submit was judged as his");
          assert.deepEqual(stored.seats.map((seat) => seat.principal_id), [devPrincipal(ALICE), devPrincipal(BOB)]);
        }
        assert.deepEqual(control.indices(gameId), []);
        await bob.close();
      } finally {
        await stopServer(server);
      }
    }
  });
});

describe("restarts", () => {
  test("28: a nonce survives a restart -- the retry of a stored submission is a catch-up, not a second move", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live3a-nonce-"));
    try {
      const records = createMemoryRecordStore();
      const gameId = await seedGame(records, [ALICE, BOB], { dealt: true });
      assert.equal((await createFileLogStore(directory).appendBatch(gameId, storedLog(0))).kind, "committed");
      const first = await startServer({ store: createFileLogStore(directory), records });
      const alice = await Client.open(first.port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(BUY, { baseIndex: 0, submissionId: "buy-n" });
      assert.equal((await alice.answerTo("buy-n")).kind, "applied");
      await alice.close();
      await stopServer(first.server);

      const second = await startServer({ store: createFileLogStore(directory), records });
      const back = await Client.open(second.port, ALICE);
      back.hello(gameId);
      await back.next((f) => f.kind === "catch-up");
      back.submit(BUY, { baseIndex: 0, submissionId: "buy-n" });
      const retry = await back.answerTo("buy-n");
      assert.equal(retry.kind, "catch-up");
      assert.equal((retry.entries as SeenEntry[])[0].submission_id, "buy-n");
      const lines = fs.readFileSync(path.join(directory, `${gameId}.log.jsonl`), "utf8").trim().split("\n");
      assert.equal(lines.length, 2);
      // And the restored board is the committed one: its digest is what the catch-up carries.
      const restored = probeSession("verify");
      // LIVE-3B: one line per entry still, each stamped with its batch -- store metadata, stripped before replay.
      assert.deepEqual(JSON.parse(lines[1]).batch, [1, 1]);
      restored.restore(lines.map((line) => stripStoreMetadata(JSON.parse(line))));
      assert.equal(stateDigest(restored.state), retry.digest);
      await back.close();
      await stopServer(second.server);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

// Keep the type import honest for readers of the frames above.
export type { Frame };
