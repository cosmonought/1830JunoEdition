// server/src/rooms/l5_3Ownership.test.ts
//
// LIVE-5 L5-3: the rooms layer under POOL ownership (`gameOwnership.ts`), over real sockets and memory stores, with a
// scripted ownership standing in for the DynamoDB one (whose own behaviour is `poolOwnership.dynamoLocal.test.ts`):
//
//   - the claim is the load's FIRST step: a game routed elsewhere is not read at all, and is not served;
//   - a claim that finds no HEAD for a game that has data refuses the load (never served as writable);
//   - a commit refused by an ownership fence is answered as nothing-written, reported once with its scope, runs nothing
//     queued behind it, and drops the actor: its subscribers are told and their sockets close 1012; the next ask
//     claims afresh;
//   - an evicted idle no-money game is released; a discarded (fenced) one is not; claim and release keep their order;
//   - discovery under POOL ownership writes nothing, and the hold it found is written by the load after its claim;
//   - PROCESS ownership (every existing suite) is untouched: nothing is claimed, released or reported.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { FENCED_DETAIL, POOL_FENCED_DETAIL, StoreDefiniteError } from "../persistence/storeResult";
import { createMemoryRecordStore } from "./recordStore";
import { createMemoryHoldStore, makeHold } from "./holdStore";
import { GameRegistry } from "./gameRegistry";
import { GameRoutedError, PROCESS_OWNERSHIP, type ClaimAnswer, type GameOwnership } from "./gameOwnership";
import type { GameActor } from "./gameActor";
import { discoverGames } from "./discovery";
import { NO_OPS } from "../persistence/opsRecorder";
import { GAME_MOVED_SENTENCE } from "../gameServer";
import type { FenceScope } from "../persistence/storeResult";
import { GAME_A, GAME_B, makeWorld, startedGame } from "../escrow/escrow3bSupport";
import type { MemoryFinancialGameStore } from "../escrow/financialGameStore";
import { ALICE, BOB, BUY, CAROL, Client, controlledStore, openGame, quietConsole, seedGame, seededRecord, startServer, stopServer, storedLog, until } from "./testSupport";

quietConsole();

const hold = (gameId: string) => makeHold({ gameId, code: "record-unreadable", detail: "planted", at: 1, source: "load", build: "b", rulesEngineVersion: 11, evidence: {} });

function scriptedOwnership() {
  const calls = { claims: [] as string[], releases: [] as string[], fenced: [] as Array<[string, FenceScope]>, order: [] as string[] };
  let answer: (gameId: string) => Promise<ClaimAnswer> = async () => ({ kind: "claimed" });
  const ownership: GameOwnership = {
    mode: "pool",
    claim: (gameId) => {
      calls.claims.push(gameId);
      calls.order.push(`claim:${gameId}`);
      return answer(gameId);
    },
    release: (gameId) => {
      calls.releases.push(gameId);
      calls.order.push(`release:${gameId}`);
    },
    onFenced: (gameId, scope) => {
      calls.fenced.push([gameId, scope]);
    },
  };
  return {
    ownership,
    calls,
    answerWith(next: (gameId: string) => Promise<ClaimAnswer>) {
      answer = next;
    },
  };
}

async function dealtGame(control: ReturnType<typeof controlledStore>) {
  const records = createMemoryRecordStore();
  const gameId = await seedGame(records, [ALICE, BOB], { dealt: true });
  control.logs.set(gameId, storedLog(0));
  return { records, gameId };
}

describe("L5-3: the claim is the load's first step", () => {
  test("a game owned by another pool is routed: nothing of it is read, nothing is served, and the next ask claims again", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    const owned = scriptedOwnership();
    owned.answerWith(async (g) => {
      throw new GameRoutedError(g, "pool-b");
    });
    const { server, port } = await startServer({ store: control.store, records, ownership: owned.ownership });
    try {
      await server.lifecycle.ready;
      const loadsBefore = control.calls.loadLog;
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      const answer = await alice.next((f) => f.kind === "error" || f.kind === "catch-up" || f.kind === "refused");
      assert.notEqual(answer.kind, "catch-up", "a routed game serves no history");
      assert.equal(control.calls.loadLog, loadsBefore, "the claim precedes every read: the routed game's log was never opened");
      assert.equal(server.residentGames(), 0, "the failed load left no actor behind");
      assert.ok(owned.calls.claims.includes(gameId));
      /* The owner gives it back: the very next ask claims again, and it is served. */
      owned.answerWith(async () => ({ kind: "claimed" }));
      const bob = await Client.open(port, BOB);
      bob.hello(gameId);
      const caught = await bob.next((f) => f.kind === "catch-up");
      assert.deepEqual((caught.entries as Array<{ index: number }>).map((e) => e.index), [0]);
      assert.ok(owned.calls.claims.filter((g) => g === gameId).length >= 2, "claimed afresh");
      await Promise.all([alice.close(), bob.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("a claim that finds no HEAD for a game that HAS data refuses the load (it could never be written here)", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    const owned = scriptedOwnership();
    owned.answerWith(async () => ({ kind: "absent" }));
    const { server, port } = await startServer({ store: control.store, records, ownership: owned.ownership });
    try {
      await server.lifecycle.ready;
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      const answer = await alice.next((f) => f.kind === "error" || f.kind === "catch-up" || f.kind === "refused");
      assert.notEqual(answer.kind, "catch-up", "not served");
      assert.equal(server.residentGames(), 0);
      assert.deepEqual(control.indices(gameId), [0], "nothing was written");
      await alice.close();
    } finally {
      await stopServer(server);
    }
  });

  test("a table CREATED under pool ownership loads on `absent` (its first write makes the HEAD) and is played", async () => {
    const control = controlledStore();
    const owned = scriptedOwnership();
    owned.answerWith(async () => ({ kind: "absent" }));
    const { server, port } = await startServer({ store: control.store, ownership: owned.ownership });
    try {
      await server.lifecycle.ready;
      const opened = await openGame(port, ALICE, [BOB]);
      assert.ok(owned.calls.claims.includes(opened.gameId), "the new table's load claimed first");
      assert.ok(control.indices(opened.gameId).length > 0, "created, seated and dealt: its writes made its history");
    } finally {
      await stopServer(server);
    }
  });
});

describe("L5-3: the fenced reaction", () => {
  async function fencedServer(detail: string) {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    const owned = scriptedOwnership();
    /* The first append is refused by the ownership fence (as the DynamoDB adapters answer it); it is HELD until the test
       releases it, so a second move can queue behind it. */
    let refuse: (() => void) | null = null;
    const append = control.store.appendLog.bind(control.store);
    let appends = 0;
    control.store.appendLog = (room, entries) => {
      appends += 1;
      if (appends === 1) return new Promise<void>((_resolve, reject) => (refuse = () => reject(new StoreDefiniteError(detail))));
      return append(room, entries);
    };
    const { server, port } = await startServer({ store: control.store, records, ownership: owned.ownership });
    await server.lifecycle.ready;
    return { control, records, gameId, owned, server, port, release: () => refuse?.(), appends: () => appends };
  }

  test("a GAME fence: answered as nothing written, reported once, nothing queued behind it runs, the actor is dropped and its subscribers told (1012); the next ask claims afresh", async () => {
    const run = await fencedServer(FENCED_DETAIL);
    const { control, gameId, owned, server, port } = run;
    try {
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      const bob = await Client.open(port, BOB);
      bob.hello(gameId);
      await bob.next((f) => f.kind === "catch-up");
      const claimsBefore = owned.calls.claims.filter((g) => g === gameId).length;

      alice.submit(BUY, { baseIndex: 0, submissionId: "a-buy" });
      await until(() => run.appends() === 1, "the first append");
      /* A second move queues behind the fenced one (Alice's second tab, on the same committed view). */
      const tab = await Client.open(port, ALICE);
      tab.hello(gameId);
      await tab.next((f) => f.kind === "catch-up");
      tab.submit(BUY, { baseIndex: 0, submissionId: "a2-buy" });
      await new Promise((resolve) => setTimeout(resolve, 30));
      run.release();

      const first = await alice.answerTo("a-buy");
      assert.deepEqual([first.kind, first.code], ["refused", "retry"], "nothing was written: the definite answer");
      const queued = await tab.answerTo("a2-buy");
      assert.equal(queued.kind, "refused", "the queued move never ran");
      assert.equal(run.appends(), 1, "no append after the fence: nothing queued behind it ran, nothing was retried");
      assert.deepEqual(owned.calls.fenced, [[gameId, "game"]], "reported once, with its scope");

      const told = await bob.next((f) => f.kind === "status" && f.state === "unavailable");
      assert.equal(told.reason, GAME_MOVED_SENTENCE);
      assert.equal(await bob.closed, 1012, "the subscriber's socket closes 1012: it reconnects to the game's writer");
      assert.equal(await alice.closed, 1012);
      await until(() => server.residentGames() === 0, "the fenced actor dropped");
      assert.deepEqual(control.indices(gameId), [0], "the store holds exactly the deal");
      assert.deepEqual(owned.calls.releases, [], "a fenced game is not this task's to release");

      /* The next ask builds a fresh actor, which claims afresh. */
      const carol = await Client.open(port, CAROL);
      carol.hello(gameId);
      await carol.next((f) => f.kind === "catch-up" || f.kind === "error");
      assert.equal(owned.calls.claims.filter((g) => g === gameId).length, claimsBefore + 1, "claimed afresh");
      await Promise.all([tab.close(), carol.close()]);
    } finally {
      await stopServer(server);
    }
  });

  test("a POOL fence is reported with its scope (the pool writer gives the whole pool up)", async () => {
    const run = await fencedServer(POOL_FENCED_DETAIL);
    const { gameId, owned, server, port } = run;
    try {
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(BUY, { baseIndex: 0, submissionId: "a-buy" });
      await until(() => run.appends() === 1, "the first append");
      run.release();
      const first = await alice.answerTo("a-buy");
      assert.deepEqual([first.kind, first.code], ["refused", "retry"]);
      assert.deepEqual(owned.calls.fenced, [[gameId, "pool"]]);
    } finally {
      await stopServer(server);
    }
  });

  test("a definite refusal that is NOT a fence changes nothing: the actor stays, nothing is reported", async () => {
    const run = await fencedServer("injected append failure");
    const { gameId, owned, server, port } = run;
    try {
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(BUY, { baseIndex: 0, submissionId: "a-buy" });
      await until(() => run.appends() === 1, "the first append");
      run.release();
      assert.equal((await alice.answerTo("a-buy")).code, "retry");
      alice.submit(BUY, { baseIndex: 0, submissionId: "a-buy-2" });
      assert.equal((await alice.answerTo("a-buy-2")).kind, "applied", "the same actor keeps playing");
      assert.deepEqual(owned.calls.fenced, []);
      assert.equal(server.residentGames(), 1);
      await alice.close();
    } finally {
      await stopServer(server);
    }
  });

  test("PROCESS ownership: a fence text from a store is not acted on (only POOL ownership drops actors)", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    const append = control.store.appendLog.bind(control.store);
    let appends = 0;
    control.store.appendLog = (room, entries) => {
      appends += 1;
      return appends === 1 ? Promise.reject(new StoreDefiniteError(FENCED_DETAIL)) : append(room, entries);
    };
    const { server, port } = await startServer({ store: control.store, records, ownership: PROCESS_OWNERSHIP });
    try {
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      alice.submit(BUY, { baseIndex: 0, submissionId: "a-buy" });
      assert.equal((await alice.answerTo("a-buy")).code, "retry");
      alice.submit(BUY, { baseIndex: 0, submissionId: "a-buy-2" });
      assert.equal((await alice.answerTo("a-buy-2")).kind, "applied");
      await alice.close();
    } finally {
      await stopServer(server);
    }
  });
});

describe("L5-3: release on eviction, and the order of claims and releases", () => {
  test("an evicted idle NO-MONEY game is released; the next load claims after the release", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    const owned = scriptedOwnership();
    const { server, port } = await startServer({ store: control.store, records, ownership: owned.ownership });
    try {
      await server.lifecycle.ready;
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      await alice.close();
      await until(() => server.residentGames() === 1, "resident");
      /* Idle once its subscriber left: evicted by the registry's own sweep (run with a clock far ahead). */
      await until(() => server.evictIdleGames(Date.now() + 24 * 3600_000).length === 1 || server.residentGames() === 0, "evicted");
      assert.deepEqual(owned.calls.releases, [gameId]);
      const bob = await Client.open(port, BOB);
      bob.hello(gameId);
      await bob.next((f) => f.kind === "catch-up");
      const order = owned.calls.order.filter((line) => line.endsWith(gameId));
      assert.deepEqual(order.slice(-2), [`release:${gameId}`, `claim:${gameId}`], "the release was asked before the next load's claim");
      await bob.close();
    } finally {
      await stopServer(server);
    }
  });

  test("the registry: an eviction reports after the actor is disposed; a discard never does", () => {
    const events: string[] = [];
    const fake = (id: string) =>
      ({
        gameId: id,
        ready: Promise.resolve(),
        idle: true,
        lastActiveAt: 0,
        dispose: () => events.push(`dispose:${id}`),
      }) as unknown as GameActor;
    const actors = new Map<string, GameActor>();
    const registry = new GameRegistry({
      evictable: true,
      sweepMs: 3_600_000,
      now: () => 0,
      create: (id) => {
        const actor = fake(id);
        actors.set(id, actor);
        return actor;
      },
      onEvicted: (id) => events.push(`evicted:${id}`),
    });
    try {
      void registry.get("g_a");
      void registry.get("g_b");
      assert.equal(registry.discard("g_a", actors.get("g_a") as GameActor), true);
      assert.equal(registry.discard("g_a", actors.get("g_a") as GameActor), false, "only the resident actor is discarded");
      assert.deepEqual(registry.evictIdle(10 * 3_600_000), ["g_b"]);
      assert.deepEqual(events, ["dispose:g_a", "dispose:g_b", "evicted:g_b"]);
    } finally {
      registry.close();
    }
  });
});

describe("L5-3: before the sweep claims a game back, a resident actor is dropped -- only when quiescent", () => {
  test("`retakeResident`: no actor -> yes; an actor with a write in flight -> not now; a quiescent one -> dropped (its subscribers told, 1012) and the next load reads afresh", async () => {
    const control = controlledStore();
    const { records, gameId } = await dealtGame(control);
    const owned = scriptedOwnership();
    const { server, port } = await startServer({ store: control.store, records, ownership: owned.ownership });
    try {
      await server.lifecycle.ready;
      assert.equal(server.retakeResident(gameId), true, "nothing resident");
      const alice = await Client.open(port, ALICE);
      alice.hello(gameId);
      await alice.next((f) => f.kind === "catch-up");
      control.control.holdAppends = true;
      alice.submit(BUY, { baseIndex: 0, submissionId: "a-buy" });
      const inFlight = await control.nextHeldAppend();
      assert.equal(server.retakeResident(gameId), false, "a write of it is in flight: never re-armed under a new claim");
      assert.equal(server.residentGames(), 1);
      inFlight.release();
      assert.equal((await alice.answerTo("a-buy")).kind, "applied");
      control.control.holdAppends = false;
      assert.equal(server.retakeResident(gameId), true, "quiescent: dropped");
      assert.equal(server.residentGames(), 0);
      assert.equal((await alice.next((f) => f.kind === "status")).reason, GAME_MOVED_SENTENCE);
      assert.equal(await alice.closed, 1012);
      const claims = owned.calls.claims.filter((g) => g === gameId).length;
      const bob = await Client.open(port, BOB);
      bob.hello(gameId);
      const caught = await bob.next((f) => f.kind === "catch-up");
      assert.deepEqual((caught.entries as Array<{ index: number }>).map((e) => e.index), [0, 1], "loaded afresh from the store");
      assert.equal(owned.calls.claims.filter((g) => g === gameId).length, claims + 1, "after its own claim");
      await bob.close();
    } finally {
      await stopServer(server);
    }
  });
});

describe("L5-3: discovery under POOL ownership writes nothing", () => {
  test("a read-only scan reports the hold and writes neither it nor the join-code index; the load decides after its claim (a startup snapshot is never enforced or written), and a durable hold holds", async () => {
    const holds = createMemoryHoldStore();
    /* Two live records on one join code: discovery holds both (`duplicate-join-code`). Planted as a damaged directory would
       hold them (the memory store itself would refuse the second claim of the code). */
    const first = { ...seededRecord([ALICE, BOB]), join_code: "JUNO-DUPE-CODE" };
    const second = { ...seededRecord([ALICE, CAROL]), join_code: "JUNO-DUPE-CODE" };
    const planted = new Map([first, second].map((record) => [record.game_id, record]));
    const memory = createMemoryRecordStore();
    let indexWrites = 0;
    const records = {
      ...memory,
      list: async () => [...planted.keys()],
      load: async (gameId: string) => planted.get(gameId) ?? null,
      reconcileIndex: async (...args: Parameters<NonNullable<typeof memory.reconcileIndex>>) => {
        indexWrites += 1;
        return (memory.reconcileIndex as NonNullable<typeof memory.reconcileIndex>)(...args);
      },
    };
    const report = await discoverGames({ records, logs: {}, holds, build: "b", rulesEngineVersion: 11, now: () => 1, warn: () => undefined, ops: NO_OPS, readOnly: true });
    assert.equal(report.games.get(first.game_id)?.cls, "held");
    assert.equal(report.games.get(second.game_id)?.cls, "held");
    assert.equal(report.holdsCreated, 0);
    assert.deepEqual(await holds.list(), [], "no hold written by the scan");
    assert.equal(indexWrites, 0, "the join-code index is left as found");

    /* The server under POOL ownership: the load (after its claim) writes the hold discovery found. */
    const owned = scriptedOwnership();
    const control = controlledStore();
    const { server, port } = await startServer({ store: control.store, records, holds, ownership: owned.ownership });
    try {
      await server.lifecycle.ready;
      assert.deepEqual(await holds.list(), [], "the server's own discovery wrote nothing either");
      /* A startup snapshot is never enforced or written in the load's place (review M1: an operator may have released the
         game since, or the disagreement was a deal in flight on the previous task): the load decides after its claim. The
         game -- a waiting table with no log -- loads and is served, and nothing is written for it. */
      const alice = await Client.open(port, ALICE);
      alice.hello(first.game_id);
      const answered = await alice.next((f) => f.kind === "error" || f.kind === "catch-up");
      assert.equal(answered.kind, "catch-up", "served: the discovery hint is not a hold");
      assert.ok(owned.calls.claims.includes(first.game_id), "claimed first");
      assert.deepEqual(await holds.list(), [], "and nothing was written for it");
      /* A DURABLE hold, read after the claim, holds as always. */
      assert.equal((await holds.create({ ...hold(second.game_id) })).outcome.kind, "committed");
      alice.hello(second.game_id);
      const held = await alice.next((f) => f.kind === "error" || f.kind === "catch-up");
      assert.deepEqual([held.kind, held.code], ["error", "held"]);
      await alice.close();
    } finally {
      await stopServer(server);
    }
  });
});

describe("L5-3: the frozen-roster fact comes from the claim's read", () => {
  test("a roster frozen by ANOTHER task after this task's preload is learned at the claim (`refreshRoster`); an unreadable record counts as frozen", async () => {
    const world = makeWorld();
    const created = await world.service.createMoneyGame(GAME_A);
    assert.ok(created.ok);
    /* This task: preloaded before the freeze (as at its startup). */
    const other = makeWorld({ financial: world.financial, intents: world.intents, journal: world.journal, tickets: world.tickets });
    await other.service.preload();
    assert.equal(other.service.isRosterFrozen(GAME_A), false);
    /* Another task freezes the roster and starts the game. */
    await startedGame(world, GAME_A);
    assert.equal(world.service.isRosterFrozen(GAME_A), true);
    assert.equal(other.service.isRosterFrozen(GAME_A), false, "the preload is stale: it cannot see a freeze made after it");
    await other.service.refreshRoster(GAME_A);
    assert.equal(other.service.isRosterFrozen(GAME_A), true, "the claim's read decides");
    /* No financial record: not frozen. An unreadable one: frozen (a seat never moves on a guess). */
    await other.service.refreshRoster(GAME_B);
    assert.equal(other.service.isRosterFrozen(GAME_B), false);
    (world.financial as MemoryFinancialGameStore).records.set(GAME_B, "unreadable");
    await other.service.refreshRoster(GAME_B);
    assert.equal(other.service.isRosterFrozen(GAME_B), true);
  });
});
