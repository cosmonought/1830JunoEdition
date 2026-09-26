// server/src/rooms/gameActor.test.ts
//
// LIVE-3A: the per-game actor and the durable-before-visible commit pipeline, against the real server, the real
// `RoomSession` and real sockets, over a store the test controls. Run with `npm test` in server/ (after
// `npm run build`). The numbered cases are the LIVE-3A brief's mandatory list; P1/P2/P2b/P4 are LIVE-3 Appendix
// A's reproductions, as regressions.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createFileLogStore, type LogStore } from "../fileLogStore";
import { COMMITTED } from "../persistence/storeResult";
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
  hostRoom,
  hostedDoc,
  probeSession,
  quietConsole,
  sleep,
  startServer,
  stopServer,
  storedLog,
  until,
  type Frame,
  type SeenEntry,
} from "./testSupport";

quietConsole();

const ROOM = "L3A";

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
      loadRoomDoc: async () => null,
      saveRoomDoc: async () => COMMITTED,
    };
    const actor = new GameActor({
      gameId: "UNIT",
      build: BUILD,
      explainDivergence: false,
      store: port,
      newSession: () => probeSession("unit"),
      restore: (session, entries) => session.restore(entries),
      loadRoomDoc: async () => null,
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
            loadRoomDoc: async () => null,
            saveRoomDoc: async () => COMMITTED,
          },
          newSession: () => probeSession("reg"),
          restore: (session, entries) => session.restore(entries),
          loadRoomDoc: async () => null,
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
    control.control.holdAppends = true;
    const { server, port } = await startServer({ store: control.store });
    try {
      await hostRoom(port, ROOM); // LIVE-2A: a room nobody hosted is not dealt (§15 #9)
      const alice = await Client.open(port, ALICE);
      alice.hello(ROOM);
      assert.deepEqual((await alice.next((f) => f.kind === "catch-up")).inFlight, []);
      alice.submit(SETUP, { baseIndex: -1, submissionId: "a-deal" });
      const deal = await control.nextHeldAppend();

      // 4: Bob's hello while the deal awaits the disk sees the committed prefix -- nothing -- not the deal.
      const bob = await Client.open(port, BOB);
      bob.hello(ROOM);
      const bobHello = await bob.next((f) => f.kind === "catch-up");
      assert.deepEqual(bobHello.entries, []);

      // 2: Alice's second tab submits a move that only makes sense on top of the pending deal.
      const tab = await Client.open(port, ALICE);
      tab.hello(ROOM);
      await tab.next((f) => f.kind === "catch-up");
      tab.submit(BUY, { baseIndex: 0, submissionId: "a2-buy" });
      await sleep(30);
      // 1, 3: it has not run -- the store has seen exactly one append, and nothing was answered.
      assert.equal(control.calls.appendLog, 1);
      assert.equal(tab.of("refused").length + tab.of("applied").length, 0);

      // The deal's append fails, and nothing of it is anywhere.
      deal.fail(false);
      const dealAnswer = await alice.answerTo("a-deal");
      assert.deepEqual([dealAnswer.kind, dealAnswer.code], ["refused", "retry"]);
      // The queued move is judged only now, against the durable history it never saw: `ahead`.
      const tabAnswer = await tab.answerTo("a2-buy");
      assert.deepEqual([tabAnswer.kind, tabAnswer.code, tabAnswer.watermark], ["refused", "ahead", -1]);
      assert.deepEqual(control.indices(ROOM), []);
      assert.equal(bob.of("applied").length, 0);
      assert.equal(server.counters.submitAhead, 1);

      // A fresh hello -- and a restarted server -- agree: the room is empty.
      const carol = await Client.open(port, CAROL);
      carol.hello(ROOM);
      assert.deepEqual((await carol.next((f) => f.kind === "catch-up")).entries, []);
      await Promise.all([alice.close(), bob.close(), tab.close(), carol.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("P1, committed (5, 25): the queued move runs on the committed deal; fan-out follows commit order with no gap or repeat", async () => {
    const control = controlledStore();
    control.control.holdAppends = true;
    const { server, port } = await startServer({ store: control.store });
    try {
      await hostRoom(port, ROOM); // LIVE-2A: a room nobody hosted is not dealt (§15 #9)
      const alice = await Client.open(port, ALICE);
      const bob = await Client.open(port, BOB);
      const tab = await Client.open(port, ALICE);
      for (const client of [alice, bob, tab]) {
        client.hello(ROOM);
        await client.next((f) => f.kind === "catch-up");
      }
      alice.submit(SETUP, { baseIndex: -1, submissionId: "a-deal" });
      const deal = await control.nextHeldAppend();
      tab.submit(BUY, { baseIndex: 0, submissionId: "a2-buy" });
      await sleep(20);
      deal.release();
      const dealt = await alice.answerTo("a-deal");
      assert.equal(dealt.kind, "applied");
      const buy = await control.nextHeldAppend(); // the queued move ran only now, on the committed deal
      assert.equal(buy.entries[0].index, 1);
      buy.release();
      const bought = await tab.answerTo("a2-buy");
      assert.equal(bought.kind, "applied");

      // A late joiner sees both in its catch-up, and no fan-out of either.
      const carol = await Client.open(port, CAROL);
      carol.hello(ROOM);
      const carolHello = await carol.next((f) => f.kind === "catch-up");
      assert.deepEqual((carolHello.entries as SeenEntry[]).map((e) => e.index), [0, 1]);
      await sleep(20);
      assert.equal(carol.of("applied").length, 0);

      // Bob subscribed before either publish: exactly one fan-out of each, in commit order, never a direct answer.
      const bobApplied = bob.of("applied");
      assert.deepEqual(bobApplied.map((f) => (f.entries as SeenEntry[])[0].index), [0, 1]);
      assert.ok(bobApplied.every((f) => f.inReplyTo === undefined));
      for (const client of [alice, bob, tab, carol]) assertCoherent(client, control.log(ROOM), client.claim);
      assert.deepEqual(control.indices(ROOM), [0, 1]);
      await Promise.all([alice.close(), bob.close(), tab.close(), carol.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("P2 (6, 7): two first-touch hellos after a restart load one actor; no acknowledged index disappears or repeats", async () => {
    const control = controlledStore();
    control.logs.set(ROOM, storedLog(0));
    control.control.loadDelayMs = 30;
    const { server, port } = await startServer({ store: control.store });
    try {
      const alice = await Client.open(port, ALICE);
      const bob = await Client.open(port, BOB);
      alice.hello(ROOM);
      bob.hello(ROOM); // both first touches, inside the same slow load
      const [a, b] = await Promise.all([alice.next((f) => f.kind === "catch-up"), bob.next((f) => f.kind === "catch-up")]);
      assert.equal(control.calls.loadLog, 1);
      assert.deepEqual(a.entries, b.entries);
      const deal = (a.entries as SeenEntry[])[0];

      alice.submit(BUY, { baseIndex: 0, baseId: deal.id, submissionId: "a-buy" });
      const bought = await alice.answerTo("a-buy");
      assert.equal(bought.kind, "applied");
      // Both subscribers are on the one actor: Bob hears it.
      const heard = await bob.next((f) => f.kind === "applied");
      assert.deepEqual((heard.entries as SeenEntry[]).map((e) => e.index), [1]);

      const carol = await Client.open(port, CAROL);
      carol.hello(ROOM);
      assert.deepEqual(((await carol.next((f) => f.kind === "catch-up")).entries as SeenEntry[]).map((e) => e.index), [0, 1]);

      const first = (heard.entries as SeenEntry[])[0];
      bob.submit(BUY, { baseIndex: 1, baseId: first.id, submissionId: "b-buy" });
      assert.equal((await bob.answerTo("b-buy")).kind, "applied");
      assert.deepEqual(control.indices(ROOM), [0, 1, 2]);
      assert.equal(control.calls.loadLog, 1);
      await Promise.all([alice.close(), bob.close(), carol.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("P2b (8): a delayed append cannot be overtaken -- the file holds 0,1,2 and a restart mints 3", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "live3a-p2b-"));
    const file = createFileLogStore(directory);
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
        .readFileSync(path.join(directory, `${ROOM}.log.jsonl`), "utf8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as SeenEntry).index);
    try {
      const { server, port } = await startServer({ store });
      await hostRoom(port, ROOM); // LIVE-2A: a room nobody hosted is not dealt (§15 #9)
      const alice = await Client.open(port, ALICE);
      alice.hello(ROOM);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(SETUP, { baseIndex: -1, submissionId: "deal" });
      assert.equal((await alice.answerTo("deal")).kind, "applied");

      delayNext = true;
      alice.submit(BUY, { baseIndex: 0, submissionId: "a-buy" });
      await sleep(10);
      // Bob's hello lands inside Alice's delayed append: he sees only the durable deal.
      const bob = await Client.open(port, BOB);
      bob.hello(ROOM);
      const bobHello = await bob.next((f) => f.kind === "catch-up");
      assert.deepEqual((bobHello.entries as SeenEntry[]).map((e) => e.index), [0]);
      // Bob's move for index 2 waits for Alice's append to resolve; it cannot be written first.
      bob.submit(BUY, { baseIndex: 1, submissionId: "b-buy" });
      assert.equal((await alice.answerTo("a-buy")).kind, "applied");
      assert.equal((await bob.answerTo("b-buy")).kind, "applied");
      assert.deepEqual(lines(), [0, 1, 2]);
      await Promise.all([alice.close(), bob.close()]);
      await stopServer(server);

      const restarted = await startServer({ store: createFileLogStore(directory) });
      const carol = await Client.open(restarted.port, ALICE);
      carol.hello(ROOM);
      const back = await carol.next((f) => f.kind === "catch-up");
      assert.deepEqual((back.entries as SeenEntry[]).map((e) => e.index), [0, 1, 2]);
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
    control.logs.set(ROOM, storedLog(1)); // [deal, alice's buy]: watermark 1, Bob on turn
    const { server, port } = await startServer({ store: control.store });
    try {
      const alice = await Client.open(port, ALICE);
      const bob = await Client.open(port, BOB);
      alice.hello(ROOM);
      bob.hello(ROOM);
      const history = (await alice.next((f) => f.kind === "catch-up")).entries as SeenEntry[];
      await bob.next((f) => f.kind === "catch-up");

      // 9: below the watermark is stale -- a catch-up naming the submission.
      bob.submit(BUY, { baseIndex: 0, baseId: history[0].id, submissionId: "b-stale" });
      const stale = await bob.answerTo("b-stale");
      assert.equal(stale.kind, "catch-up");
      assert.deepEqual((stale.entries as SeenEntry[]).map((e) => e.index), [1]);

      // 11: above it is `ahead`, with the watermark, and nothing is run.
      bob.submit(BUY, { baseIndex: 9, submissionId: "b-ahead" });
      const ahead = await bob.answerTo("b-ahead");
      assert.deepEqual([ahead.kind, ahead.code, ahead.watermark], ["refused", "ahead", 1]);

      // 12: at the watermark but anchored to an entry the room does not hold: `resync`, nothing run.
      bob.submit(BUY, { baseIndex: 1, baseId: "not-this-rooms", submissionId: "b-anchor" });
      const anchor = await bob.answerTo("b-anchor");
      assert.deepEqual([anchor.kind, anchor.code], ["refused", "resync"]);
      assert.deepEqual(control.indices(ROOM), [0, 1]);

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
      assert.deepEqual(control.indices(ROOM), [0, 1, 2]);

      // 27: a client that sends no anchor gets the index-only rules, on hello and submit alike.
      const legacy = await Client.open(port, ALICE);
      legacy.hello(ROOM, 1);
      assert.deepEqual(((await legacy.next((f) => f.kind === "catch-up")).entries as SeenEntry[]).map((e) => e.index), [2]);
      legacy.submit(BUY, { baseIndex: 2, submissionId: "legacy-buy" });
      assert.equal((await legacy.answerTo("legacy-buy")).kind, "applied");

      assert.equal(server.counters.submitAhead, 1);
      assert.equal(server.counters.submitResync, 1);
      await Promise.all([alice.close(), bob.close(), legacy.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("12: a hello ahead of the room, or anchored to another history, is told `resync` and not subscribed", async () => {
    const control = controlledStore();
    control.logs.set(ROOM, storedLog(1));
    const { server, port } = await startServer({ store: control.store });
    try {
      const ahead = await Client.open(port, BOB);
      ahead.hello(ROOM, 5);
      const refused = await ahead.next((f) => f.kind === "error");
      assert.deepEqual([refused.code, refused.watermark], ["resync", 1]);
      const forked = await Client.open(port, BOB);
      forked.hello(ROOM, 1, "some-other-history");
      assert.equal((await forked.next((f) => f.kind === "error")).code, "resync");
      assert.equal(server.counters.helloResync, 2);

      // Neither is subscribed: a move now reaches neither. Re-joining from -1 is the way back.
      const alice = await Client.open(port, ALICE);
      alice.hello(ROOM);
      await alice.next((f) => f.kind === "catch-up");
      const log = control.log(ROOM);
      const bob = await Client.open(port, BOB);
      bob.hello(ROOM, 1, log[1].id);
      await bob.next((f) => f.kind === "catch-up");
      bob.submit(BUY, { baseIndex: 1, baseId: log[1].id, submissionId: "b-buy" });
      assert.equal((await bob.answerTo("b-buy")).kind, "applied");
      await alice.next((f) => f.kind === "applied");
      await sleep(20);
      assert.equal(ahead.of("applied").length + forked.of("applied").length, 0);
      forked.hello(ROOM, -1);
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
    control.control.holdAppends = true;
    const { server, port } = await startServer({ store: control.store });
    try {
      await hostRoom(port, ROOM); // LIVE-2A: a room nobody hosted is not dealt (§15 #9)
      const alice = await Client.open(port, ALICE);
      alice.hello(ROOM);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(SETUP, { baseIndex: -1, submissionId: "deal" });
      const deal = await control.nextHeldAppend();
      const tab = await Client.open(port, ALICE);
      tab.hello(ROOM);
      await tab.next((f) => f.kind === "catch-up");
      tab.submit(BUY, { baseIndex: 0, submissionId: "queued-buy" });
      await sleep(20);
      await tab.close();
      await until(() => server.counters.expiredSocketClosed === 1, "the queued task's cancellation");
      deal.release();
      assert.equal((await alice.answerTo("deal")).kind, "applied");
      await sleep(30);
      assert.equal(control.calls.appendLog, 1); // the cancelled buy never reached the store
      assert.deepEqual(control.indices(ROOM), [0]);
      await alice.close();
    } finally {
      await stopServer(server);
    }
  });

  test("17, 18: a submit RUNNING when its socket closes still commits; a reconnect sees it in `inFlight` until it lands", async () => {
    const control = controlledStore();
    control.control.holdAppends = true;
    const { server, port } = await startServer({ store: control.store });
    try {
      await hostRoom(port, ROOM); // LIVE-2A: a room nobody hosted is not dealt (§15 #9)
      const bob = await Client.open(port, BOB);
      bob.hello(ROOM);
      await bob.next((f) => f.kind === "catch-up");
      const alice = await Client.open(port, ALICE);
      alice.hello(ROOM);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(SETUP, { baseIndex: -1, submissionId: "deal-x" });
      const deal = await control.nextHeldAppend();
      await alice.close(); // gone while its commit is in flight

      // 18: the reconnecting tab is told the move is still being committed -- not lost.
      const again = await Client.open(port, ALICE);
      again.hello(ROOM);
      const hello = await again.next((f) => f.kind === "catch-up");
      assert.deepEqual(hello.entries, []);
      assert.deepEqual(hello.inFlight, ["deal-x"]);

      // 17: it commits, and both the watcher and the reconnected tab hear it as history.
      deal.release();
      const landed = await again.next((f) => f.kind === "applied");
      assert.equal(landed.inReplyTo, undefined);
      assert.equal((landed.entries as SeenEntry[])[0].submission_id, "deal-x");
      await bob.next((f) => f.kind === "applied");
      await sleep(20);
      assert.equal(again.of("abandoned").length, 0);
      assert.deepEqual(control.indices(ROOM), [0]);
      await Promise.all([bob.close(), again.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("19: a running orphan that ends without committing is `abandoned` to its player's current sockets", async () => {
    const control = controlledStore();
    control.control.holdAppends = true;
    const { server, port } = await startServer({ store: control.store });
    try {
      await hostRoom(port, ROOM); // LIVE-2A: a room nobody hosted is not dealt (§15 #9)
      const alice = await Client.open(port, ALICE);
      alice.hello(ROOM);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(SETUP, { baseIndex: -1, submissionId: "deal-y" });
      const deal = await control.nextHeldAppend();
      await alice.close();
      const again = await Client.open(port, ALICE);
      again.hello(ROOM);
      assert.deepEqual((await again.next((f) => f.kind === "catch-up")).inFlight, ["deal-y"]);
      const bob = await Client.open(port, BOB); // not Alice: never told about her submission
      bob.hello(ROOM);
      await bob.next((f) => f.kind === "catch-up");
      deal.fail(false);
      const abandoned = await again.next((f) => f.kind === "abandoned");
      assert.equal(abandoned.inReplyTo, "deal-y");
      await sleep(20);
      assert.equal(bob.of("abandoned").length, 0);
      assert.deepEqual(control.indices(ROOM), []);
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
      control.logs.set(ROOM, storedLog(1)); // [deal, Alice's buy]: Bob is on turn
      control.control.holdAppends = true;
      const { server, port } = await startServer({ store: control.store });
      try {
        const last = control.log(ROOM)[1];
        const bob = await Client.open(port, BOB);
        bob.hello(ROOM, 1, last.id);
        await bob.next((f) => f.kind === "catch-up");
        // Bob's purchase holds the actor while its append awaits the disk.
        bob.submit(BUY, { baseIndex: 1, baseId: last.id, submissionId: "b-hold" });
        const held = await control.nextHeldAppend();
        // Alice's old socket queues a move behind it, for the board after Bob's purchase...
        const old = await Client.open(port, ALICE);
        old.hello(ROOM, 1, last.id);
        await old.next((f) => f.kind === "catch-up");
        // Refused when it runs: the auction still has privates for sale (#1249).
        const move = ending === "lands" ? BUY : { OpenStockRound: {} };
        old.submit(move, { baseIndex: 2, submissionId: "a-queued" });
        await sleep(20);
        // ...and her reconnect is heard before that socket is seen to close.
        const fresh = await Client.open(port, ALICE);
        fresh.hello(ROOM, 1, last.id);
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
    control.docs.set(ROOM, JSON.stringify(hostedDoc(ROOM))); // LIVE-2A: hosted, so it can be dealt (§15 #9)
    const { server, port } = await startServer({ store: control.store });
    const original = RoomEngine.prototype.submit;
    let armed = true;
    RoomEngine.prototype.submit = function (this: RoomEngine, ...args: Parameters<typeof original>) {
      if (armed) {
        armed = false;
        throw new Error("injected reducer failure");
      }
      return original.apply(this, args);
    } as typeof original;
    try {
      const bob = await Client.open(port, BOB);
      bob.hello(ROOM);
      await bob.next((f) => f.kind === "catch-up");
      const alice = await Client.open(port, ALICE);
      alice.hello(ROOM);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(SETUP, { baseIndex: -1, submissionId: "deal-1" });
      const refused = await alice.answerTo("deal-1");
      assert.deepEqual([refused.kind, refused.code], ["refused", "internal"]);
      assert.match(String(refused.reason), /\(ref [A-Z0-9]{6}\)/);
      assert.ok(!String(refused.reason).includes("injected"), "the exception's own text is not echoed");
      await sleep(20);
      assert.equal(control.calls.appendLog, 0);
      assert.equal(bob.of("applied").length, 0);
      // Nothing it touched survived: the same submission is judged afresh and lands at index 0, not 1.
      alice.submit(SETUP, { baseIndex: -1, submissionId: "deal-1" });
      const dealt = await alice.answerTo("deal-1");
      assert.equal(dealt.kind, "applied");
      assert.equal((dealt.entries as SeenEntry[])[0].index, 0);
      assert.deepEqual(control.indices(ROOM), [0]);
      await Promise.all([alice.close(), bob.close()]);
    } finally {
      RoomEngine.prototype.submit = original;
      await stopServer(server);
    }
  });

  test("22 (E-13): a commit whose next view cannot be built is published from the store, and answered applied", async () => {
    const control = controlledStore();
    control.docs.set(ROOM, JSON.stringify(hostedDoc(ROOM))); // LIVE-2A: hosted, so it can be dealt (§15 #9)
    let armed = false;
    const { server, port } = await startServer({
      store: control.store,
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
      bob.hello(ROOM);
      await bob.next((f) => f.kind === "catch-up");
      const alice = await Client.open(port, ALICE);
      alice.hello(ROOM);
      await alice.next((f) => f.kind === "catch-up");
      armed = true;
      alice.submit(SETUP, { baseIndex: -1, submissionId: "deal" });
      const answer = await alice.answerTo("deal");
      assert.equal(answer.kind, "applied");
      assert.equal((answer.entries as SeenEntry[])[0].index, 0);
      assert.equal(server.counters.viewRebuiltFromStore, 1);
      const heard = await bob.next((f) => f.kind === "applied");
      assert.equal(heard.digest, answer.digest);
      const carol = await Client.open(port, CAROL);
      carol.hello(ROOM);
      assert.equal(((await carol.next((f) => f.kind === "catch-up")).entries as SeenEntry[]).length, 1);
      await Promise.all([alice.close(), bob.close(), carol.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("a rejected append that never landed is rolled back and answered retry; the nonce is judged afresh", async () => {
    const control = controlledStore();
    control.control.failAppends.push({ landed: false });
    const { server, port } = await startServer({ store: control.store });
    try {
      await hostRoom(port, ROOM); // LIVE-2A: a room nobody hosted is not dealt (§15 #9)
      const bob = await Client.open(port, BOB);
      bob.hello(ROOM);
      await bob.next((f) => f.kind === "catch-up");
      const alice = await Client.open(port, ALICE);
      alice.hello(ROOM);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(SETUP, { baseIndex: -1, submissionId: "d1" });
      const failed = await alice.answerTo("d1");
      assert.deepEqual([failed.kind, failed.code], ["refused", "retry"]);
      await sleep(20);
      assert.equal(bob.of("applied").length, 0);
      alice.submit(SETUP, { baseIndex: -1, submissionId: "d1" });
      assert.equal((await alice.answerTo("d1")).kind, "applied");
      assert.deepEqual(control.indices(ROOM), [0]);
      assert.equal(server.counters.storeAppendFailed, 1);
      await Promise.all([alice.close(), bob.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("21 (LIVE-3B): an append the store could not settle is `unavailable` and held for a restart -- never read back, never 'refused but stored'", async () => {
    const control = controlledStore();
    control.docs.set(ROOM, JSON.stringify(hostedDoc(ROOM))); // LIVE-2A: hosted, so it can be dealt (§15 #9)
    // The bytes reached the file, then an error the store's own redo could not settle.
    control.control.failAppends.push({ landed: true });
    const restarts: string[] = [];
    const first = await startServer({ store: control.store, onRestartRequired: (room) => restarts.push(room) });
    try {
      const bob = await Client.open(first.port, BOB);
      bob.hello(ROOM);
      await bob.next((f) => f.kind === "catch-up");
      const alice = await Client.open(first.port, ALICE);
      alice.hello(ROOM);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(SETUP, { baseIndex: -1, submissionId: "d1" });
      const unsure = await alice.answerTo("d1");
      assert.deepEqual([unsure.kind, unsure.code], ["refused", "unavailable"], "never `retry` for a move that may have landed");
      assert.equal((await bob.next((f) => f.kind === "status")).state, "unavailable");
      assert.deepEqual(restarts, [ROOM]);
      assert.equal(first.server.counters.restartRequired, 1);

      // The store DOES show the entry, and the 3A rule would have adopted it by reading it back. 3B never reads.
      await sleep(1_200); // past the 3A read-back's first attempt (1 s)
      assert.deepEqual(control.indices(ROOM), [0]);
      assert.equal(control.calls.loadLog, 1, "no read-back after an uncertain write");
      assert.equal(first.server.counters.reconciled, 0);
      assert.equal(bob.of("applied").length, 0, "nothing the actor could not vouch for was sent");
      // While held, writes are refused and nothing reaches the store.
      alice.submit(PASS, { baseIndex: -1, submissionId: "while-held" });
      assert.equal((await alice.answerTo("while-held")).code, "unavailable");
      assert.equal(control.calls.appendLog, 1);
      await Promise.all([alice.close(), bob.close()]);
    } finally {
      await stopServer(first.server);
    }

    // The restart reads what the store really holds, and the nonce makes the retry a catch-up, not a second deal.
    const second = await startServer({ store: control.store });
    try {
      const back = await Client.open(second.port, ALICE);
      back.hello(ROOM);
      const hello = await back.next((f) => f.kind === "catch-up");
      assert.deepEqual((hello.entries as SeenEntry[]).map((e) => e.submission_id), ["d1"]);
      back.submit(SETUP, { baseIndex: -1, submissionId: "d1" });
      assert.equal((await back.answerTo("d1")).kind, "catch-up");
      assert.deepEqual(control.indices(ROOM), [0]);
      await back.close();
    } finally {
      await stopServer(second.server);
    }
  });
});

describe("E-11: a store call that does not answer in time (LIVE-3B)", () => {
  test("29, 30: a late append holds the game; the next task of that game does not run; when it lands it is adopted exactly once", async () => {
    const control = controlledStore();
    control.control.holdAppends = true;
    const { server, port } = await startServer({ store: control.store, storeTimeoutMs: 60 });
    try {
      await hostRoom(port, ROOM); // LIVE-2A: a room nobody hosted is not dealt (§15 #9)
      const bob = await Client.open(port, BOB);
      bob.hello(ROOM);
      await bob.next((f) => f.kind === "catch-up");
      const alice = await Client.open(port, ALICE);
      alice.hello(ROOM);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(SETUP, { baseIndex: -1, submissionId: "d1" });
      const held = await control.nextHeldAppend();

      // Past the timeout: uncertain, not failed. The submitter is told `unavailable`, every subscriber is told.
      const unsure = await alice.answerTo("d1");
      assert.deepEqual([unsure.kind, unsure.code], ["refused", "unavailable"]);
      assert.equal((await bob.next((f) => f.kind === "status")).state, "unavailable");
      assert.equal(server.counters.storeTimeouts, 1);

      // The next task of this game queues behind the late call: it neither runs nor writes.
      bob.submit(BUY, { baseIndex: -1, submissionId: "b1" });
      await sleep(150);
      assert.equal(bob.frames.filter((f) => f.inReplyTo === "b1").length, 0, "the next task did not run");
      assert.equal(control.calls.appendLog, 1, "nothing was written behind the late call");
      // A reconnecting hello meanwhile is served the committed view and told the move is in flight.
      const tab = await Client.open(port, ALICE);
      tab.hello(ROOM);
      const reconnect = await tab.next((f) => f.kind === "catch-up");
      assert.deepEqual([reconnect.entries, reconnect.inFlight], [[], ["d1"]]);

      // It lands: adopted once -- history to every subscriber, the submitter included -- and the hold lifts.
      held.release();
      for (const client of [alice, bob, tab]) {
        const landed = await client.next((f) => f.kind === "applied", `the late deal for ${client.claim}`);
        assert.equal(landed.inReplyTo, undefined);
        assert.deepEqual((landed.entries as SeenEntry[]).map((e) => e.submission_id), ["d1"]);
      }
      assert.equal((await bob.next((f) => f.kind === "status")).state, "live");
      // Only now does the queued task run -- on the committed deal (stale: it was sent from -1).
      const b1 = await bob.answerTo("b1");
      assert.equal(b1.kind, "catch-up");
      await sleep(30);
      for (const client of [alice, bob, tab]) {
        const deals = client.seen().filter((e) => e.submission_id === "d1");
        assert.equal(new Set(deals.map((e) => e.id)).size, 1, `${client.claim} was handed exactly one deal`);
      }
      assert.equal(alice.of("abandoned").length + tab.of("abandoned").length, 0);
      assert.deepEqual(control.indices(ROOM), [0]);
      assert.equal(server.counters.lateAdopted, 1);
      assert.equal(server.counters.restartRequired, 0);
      await Promise.all([alice.close(), bob.close(), tab.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("30: a late append that then DEFINITELY fails is abandoned -- nothing stored, the hold lifts, the next move is judged afresh", async () => {
    const control = controlledStore();
    control.control.holdAppends = true;
    const { server, port } = await startServer({ store: control.store, storeTimeoutMs: 40 });
    try {
      await hostRoom(port, ROOM); // LIVE-2A: a room nobody hosted is not dealt (§15 #9)
      const alice = await Client.open(port, ALICE);
      alice.hello(ROOM);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(SETUP, { baseIndex: -1, submissionId: "d1" });
      const held = await control.nextHeldAppend();
      assert.equal((await alice.answerTo("d1")).code, "unavailable");
      held.fail(false);
      // The hold lifts, and the move that never landed is abandoned to the player who was told it was in flight.
      assert.equal((await alice.next((f) => f.kind === "status" && f.state === "live")).state, "live");
      const gone = await alice.next((f) => f.kind === "abandoned");
      assert.equal(gone.inReplyTo, "d1");
      assert.deepEqual(control.indices(ROOM), []);
      control.control.holdAppends = false;
      alice.submit(SETUP, { baseIndex: -1, submissionId: "d2" });
      assert.equal((await alice.answerTo("d2")).kind, "applied");
      assert.deepEqual(control.indices(ROOM), [0]);
      await alice.close();
    } finally {
      await stopServer(server);
    }
  });

  test("31: a late append that never settles keeps the game unavailable and asks for a restart", async () => {
    const control = controlledStore();
    control.docs.set(ROOM, JSON.stringify(hostedDoc(ROOM))); // LIVE-2A: hosted, so it can be dealt (§15 #9)
    control.control.holdAppends = true;
    const restarts: string[] = [];
    const { server, port } = await startServer({
      store: control.store,
      storeTimeoutMs: 30,
      storeRestartAfterMs: 80,
      onRestartRequired: (room, detail) => restarts.push(`${room}: ${detail}`),
    });
    try {
      const alice = await Client.open(port, ALICE);
      alice.hello(ROOM);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(SETUP, { baseIndex: -1, submissionId: "d1" });
      await control.nextHeldAppend(); // never released
      assert.equal((await alice.answerTo("d1")).code, "unavailable");
      await until(() => restarts.length === 1, "the restart request");
      assert.match(restarts[0], /has still not settled/);
      // Still held: a hello is served the committed prefix and told it is unavailable; a move does not run.
      const carol = await Client.open(port, CAROL);
      carol.hello(ROOM);
      assert.deepEqual((await carol.next((f) => f.kind === "catch-up")).entries, []);
      assert.equal((await carol.next((f) => f.kind === "status")).state, "unavailable");
      alice.submit(PASS, { baseIndex: -1, submissionId: "after" });
      await sleep(60);
      assert.equal(alice.frames.filter((f) => f.inReplyTo === "after").length, 0);
      assert.equal(control.calls.appendLog, 1);
      assert.deepEqual(control.indices(ROOM), []);
      await Promise.all([alice.close(), carol.close()]);
    } finally {
      await stopServer(server);
    }
  });
});

describe("room authority is serialized with the moves (§21 LIVE-3A, F-10)", () => {
  const openRoomDoc = async (port: number, claim: string, room: string) => {
    const client = await Client.open(port, claim);
    client.roomHello(room);
    await client.next((f) => f.kind === "presence");
    return client;
  };

  test("23: a room document the store refused leaves the previous one authoritative, in memory and on disk", async () => {
    const control = controlledStore();
    const { server, port } = await startServer({ store: control.store });
    try {
      const host = await openRoomDoc(port, ALICE, ROOM);
      host.roomWrite(ROOM, { op: "host", hostId: ALICE, nickname: "Alice", variants: {} });
      await host.next((f) => f.kind === "room" && (f.doc as { hostId?: string } | null)?.hostId === ALICE);
      const usurper = await openRoomDoc(port, BOB, ROOM);
      /* LIVE-2A (§15 #3): the old takeover -- `host` over a room that exists -- is refused before any save. */
      usurper.roomWrite(ROOM, { op: "host", hostId: BOB, nickname: "Bob", variants: {} });
      assert.equal((await usurper.next((f) => f.kind === "error")).code, "room-code-taken");
      assert.equal(control.doc(ROOM)?.hostId, ALICE);
      // A write the store refuses -- Bob's join -- leaves the previous document authoritative.
      control.control.failSaves = 1;
      usurper.roomWrite(ROOM, { op: "upsert-player", player: { id: BOB, nickname: "Bob", isReady: false } });
      const refusal = await usurper.next((f) => f.kind === "error");
      assert.equal(refusal.code, "room-write-refused");
      const unchanged = await usurper.next((f) => f.kind === "room");
      assert.deepEqual((unchanged.doc as { players: Array<{ id: string }> }).players.map((p) => p.id), [ALICE]);
      assert.deepEqual(control.doc(ROOM)?.players.map((p) => p.id), [ALICE]);
      const fresh = await openRoomDoc(port, CAROL, ROOM);
      assert.deepEqual((fresh.of("room")[0].doc as { players: Array<{ id: string }> }).players.map((p) => p.id), [ALICE]);
      // The seat PIN is authority too: a PIN the store refused is not set, and the hello gate does not ask for it.
      host.roomWrite(ROOM, { op: "upsert-player", player: { id: ALICE, nickname: "Alice", isReady: false } });
      await host.next((f) => f.kind === "room");
      control.control.failSaves = 1;
      host.send({ kind: "seat-pin", room: ROOM, requestId: "pin-1", playerId: ALICE, pin: "1234" });
      const pinAnswer = await host.next((f) => f.kind === "seat");
      assert.equal(pinAnswer.ok, false);
      assert.equal(control.doc(ROOM)?.seatPins?.[ALICE], undefined);
      const log = await Client.open(port, ALICE);
      log.hello(ROOM);
      assert.equal((await log.next((f) => f.kind === "catch-up" || f.kind === "error")).kind, "catch-up");
      await Promise.all([host.close(), usurper.close(), fresh.close(), log.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("26 (LIVE-3B): a room document whose save could not be confirmed holds the room for a restart, and is not read back", async () => {
    const control = controlledStore();
    const restarts: string[] = [];
    const { server, port } = await startServer({ store: control.store, onRestartRequired: (room) => restarts.push(room) });
    try {
      const host = await openRoomDoc(port, ALICE, ROOM);
      host.roomWrite(ROOM, { op: "host", hostId: ALICE, nickname: "Alice", variants: {} });
      await host.next((f) => f.kind === "room" && (f.doc as { hostId?: string } | null)?.hostId === ALICE);
      const watcher = await Client.open(port, BOB);
      watcher.hello(ROOM);
      await watcher.next((f) => f.kind === "catch-up");
      const usurper = await openRoomDoc(port, BOB, ROOM);
      const loadsBefore = control.calls.loadRoomDoc;
      control.control.failSavesUncertain = 1; // the rename landed, then an error the redo could not settle
      // LIVE-2A: Bob's own join (a `host` over the room is refused before any save now, §15 #3).
      usurper.roomWrite(ROOM, { op: "upsert-player", player: { id: BOB, nickname: "Bob", isReady: false } });
      const refusal = await usurper.next((f) => f.kind === "error");
      assert.equal(refusal.code, "room-write-refused");
      assert.match(String(refusal.reason), /could not confirm/);
      assert.equal((await watcher.next((f) => f.kind === "status")).state, "unavailable");
      assert.deepEqual(restarts, [ROOM]);
      assert.equal(control.calls.loadRoomDoc, loadsBefore, "the document was not read back to guess the outcome");
      // Held: the log takes no move.
      watcher.submit(SETUP, { baseIndex: -1, submissionId: "held-deal" });
      assert.equal((await watcher.answerTo("held-deal")).code, "unavailable");
      assert.deepEqual(control.indices(ROOM), []);
      await Promise.all([host.close(), usurper.close(), watcher.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("24: a submit queued behind a room write is judged under the document that write committed -- or not", async () => {
    /* LIVE-2A: no write can hand the host to somebody else any more (`host` never overwrites a room, §15 #3), so
       the authority a queued submit depends on is the room's EXISTENCE: a deal is taken only by a hosted room
       (§15 #9). The room's creation awaits the disk while the deal queues behind it. */
    for (const outcome of ["committed", "refused"] as const) {
      const control = controlledStore();
      const { server, port } = await startServer({ store: control.store });
      try {
        const alice = await Client.open(port, ALICE);
        alice.hello(ROOM);
        await alice.next((f) => f.kind === "catch-up");
        const hostDoc = await openRoomDoc(port, ALICE, ROOM);
        control.control.holdSaves = true;
        hostDoc.roomWrite(ROOM, { op: "host", hostId: ALICE, nickname: "Alice", variants: {} });
        const save = await control.nextHeldSave();
        alice.submit(SETUP, { baseIndex: -1, submissionId: "deal" });
        await sleep(30);
        assert.equal(alice.of("applied").length + alice.of("refused").length, 0, "the submit waits behind the room write");
        if (outcome === "committed") save.release();
        else save.fail();
        const answer = await alice.answerTo("deal");
        if (outcome === "committed") {
          assert.equal(answer.kind, "applied", "judged under the committed document: the room has a host");
          assert.deepEqual(control.indices(ROOM), [0]);
        } else {
          assert.equal(answer.kind, "refused", "the refused save left the room without a host");
          assert.match(String(answer.reason), /no host/);
          assert.deepEqual(control.indices(ROOM), []);
        }
        await Promise.all([alice.close(), hostDoc.close()]);
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
      const first = await startServer({ store: createFileLogStore(directory) });
      await hostRoom(first.port, ROOM); // LIVE-2A: a room nobody hosted is not dealt (§15 #9)
      const alice = await Client.open(first.port, ALICE);
      alice.hello(ROOM);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(SETUP, { baseIndex: -1, submissionId: "deal-n" });
      assert.equal((await alice.answerTo("deal-n")).kind, "applied");
      await alice.close();
      await stopServer(first.server);

      const second = await startServer({ store: createFileLogStore(directory) });
      const back = await Client.open(second.port, ALICE);
      back.hello(ROOM);
      await back.next((f) => f.kind === "catch-up");
      back.submit(SETUP, { baseIndex: -1, submissionId: "deal-n" });
      const retry = await back.answerTo("deal-n");
      assert.equal(retry.kind, "catch-up");
      assert.equal((retry.entries as SeenEntry[])[0].submission_id, "deal-n");
      const lines = fs.readFileSync(path.join(directory, `${ROOM}.log.jsonl`), "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      // And the restored board is the committed one: its digest is what the catch-up carries.
      const restored = probeSession("verify");
      // LIVE-3B: one line per entry still, each stamped with its batch -- store metadata, stripped before replay.
      assert.deepEqual(JSON.parse(lines[0]).batch, [0, 0]);
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
