// server/src/rooms/phase3Clock.test.ts
//
// PHASE 3 LANE A (AUD-11.04 / U-10; OD-18 superseded in part 2026-10-05): the Live / Async gameplay clock, through the
// real server -- sockets, the room protocol, the file stores a deployment runs, restarts -- on CONTROLLED time.
//
// What the owner asked to be proven, one test (or more) each:
//   the clock starts on the correct acting seat; another seat's clock does not run; a turn transition transfers it;
//   pause freezes the remaining time; resume continues from it; a reload shows the server's remaining time; a reconnect
//   does not reset it; a server restart does not reset it; a second tab sees the same clock; a stale tab cannot advance
//   or reset it; Live and Async read different policy slots; expiry dispatches no gameplay, forfeits nobody and produces
//   no settlement output; GameEnd stops timing; an existing no-clock (legacy) record stays readable.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createFileLogStore } from "../fileLogStore";
import type { GameServerOptions } from "../gameServer";
import { serializeBatch } from "../persistence/logFormat";
import { createMemoryOpsRecorder, type MemoryOpsRecorder } from "../persistence/opsRecorder";
import type { RoomClockView } from "../../../frontend/src/utils/clockProtocol";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { RULES_ENGINE_VERSION } from "../../../frontend/src/gameEngine/rulesVersion";
import { fakeTime, type FakeTime } from "./clockTestSupport";
import { clockDirectory, createFileClockStore, type ClockPolicy } from "./gameClock";
import { mintGameId, type GameRecord } from "./gameRecord";
import { createFileHoldStore } from "./holdStore";
import { NO_MONEY_SETTLEMENT, type SettlementLifecycle } from "./lifecycle";
import { createFileRecordStore } from "./recordStore";
import { ALICE, BOB, BUY, Client, openGame, quietConsole, seededRecord, startServer, stopServer, storedLog, until, type Frame } from "./testSupport";

quietConsole();

const SEC = 1_000;
const MIN = 60 * SEC;
const quiet = { warn: () => undefined };
/** TEST-ONLY durations (no owner-approved value exists; these exist only to exercise expiry). */
const TEST_POLICY: ClockPolicy = { live: { turnAllowanceMs: 2 * MIN }, async: { turnAllowanceMs: 6 * 60 * MIN } };

function withDir<T>(tag: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p3clock-${tag}-`));
  return body(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

interface Spies {
  settled: number;
  escrowCommitted: number;
}

interface Booted {
  server: Awaited<ReturnType<typeof startServer>>["server"];
  port: number;
  ops: MemoryOpsRecorder;
  spies: Spies;
}

/** A server over the FILE stores in `dir` -- logs, records, holds and clocks, as `start.ts` wires them -- on `time`. */
async function boot(dir: string, time: FakeTime, policy: ClockPolicy | undefined, over: Partial<GameServerOptions> = {}): Promise<Booted> {
  const store = createFileLogStore(dir, quiet);
  if (store.loadChat) await store.loadChat("settle");
  const ops = createMemoryOpsRecorder();
  const spies: Spies = { settled: 0, escrowCommitted: 0 };
  const settlement: SettlementLifecycle = {
    onGameplayClosed: () => {
      spies.settled += 1;
    },
    retentionOf: NO_MONEY_SETTLEMENT.retentionOf,
  };
  const { server, port } = await startServer({
    store,
    records: createFileRecordStore(dir, quiet),
    holds: createFileHoldStore(dir, quiet),
    clocks: createFileClockStore(dir, quiet),
    ...(policy !== undefined ? { clockPolicy: policy } : {}),
    clockNow: time.now,
    clockTimers: time.timers,
    ops,
    settlement,
    escrow: {
      onGameplayCommitted: () => {
        spies.escrowCommitted += 1;
      },
      isRosterFrozen: () => false,
    },
    ...over,
  });
  await server.lifecycle.ready;
  return { server, port, ops, spies };
}

/** The newest clock a client was shown (`undefined`: none yet). */
const latestClock = (client: Client): RoomClockView | undefined => {
  const rooms = client.of("room");
  return (rooms[rooms.length - 1]?.view as { clock?: RoomClockView } | undefined)?.clock;
};

/** Wait until a client has been shown a clock that passes `check`. */
async function clockWhere(client: Client, check: (clock: RoomClockView) => boolean, label: string): Promise<RoomClockView> {
  await until(() => {
    const clock = latestClock(client);
    return clock !== undefined && check(clock);
  }, `${label} (last clock ${JSON.stringify(latestClock(client))})`);
  return latestClock(client) as RoomClockView;
}

/** A tab on the table: its room view (with the clock) and, when asked, its log. */
async function tab(port: number, claim: string, gameId: string): Promise<Client> {
  const client = await Client.open(port, claim);
  client.roomHello(gameId);
  await clockWhere(client, () => true, `a clock for ${claim}`);
  return client;
}

/** The last log index a log client has seen (its catch-up and fan-out). */
const lastIndex = (client: Client): number => client.seen().reduce((max, entry) => Math.max(max, entry.index), -1);

/** One move through the seat's own log socket, answered `applied`. */
async function play(port: number, claim: string, gameId: string, msg: object, label: string): Promise<Frame> {
  const client = await Client.open(port, claim);
  client.hello(gameId);
  await client.next((frame) => frame.kind === "catch-up", "the catch-up");
  client.submit(msg, { baseIndex: lastIndex(client), submissionId: label });
  const answer = await client.answerTo(label);
  assert.equal(answer.kind, "applied", `${label}: ${JSON.stringify(answer)}`);
  await client.close();
  return answer;
}

/** The seat on turn buys the cheapest private. */
async function buy(port: number, claim: string, gameId: string, label: string): Promise<void> {
  await play(port, claim, gameId, BUY, label);
}

/** A table created with chosen variants (`openGame` deals `{}`), dealt by the host. */
async function openTable(port: number, variants: Record<string, unknown>): Promise<{ gameId: string; playerIds: Record<string, string> }> {
  const host = await Client.open(port, ALICE);
  const created = await host.op({ type: "create", visibility: "public", exactPlayers: null, variants, nickname: "Alice" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const { gameId, code, playerId } = created.data as { gameId: string; code: string; playerId: string };
  const guest = await Client.open(port, BOB);
  const joined = await guest.op({ type: "join", code, takeSeat: true });
  assert.equal(joined.ok, true);
  for (const client of [host, guest]) assert.equal((await client.op({ type: "set-ready", ready: true }, gameId)).ok, true);
  assert.equal((await host.op({ type: "start-game" }, gameId)).ok, true);
  const playerIds = { [ALICE]: playerId, [BOB]: (joined.data as { playerId: string }).playerId };
  await Promise.all([host.close(), guest.close()]);
  return { gameId, playerIds };
}

const settle = async (booted: Booted, gameId: string) => {
  await booted.server.rooms.clocks.settled(gameId);
};

describe("Phase 3 lane A: the gameplay clock through the server", () => {
  test("starts on the acting seat; no other seat's clock runs; a turn change hands it over and restarts it", async () =>
    withDir("seat", async (dir) => {
      const time = fakeTime(Date.now());
      const booted = await boot(dir, time, undefined);
      try {
        const table = await openGame(booted.port, ALICE, [BOB]);
        await settle(booted, table.gameId);
        const alice = await tab(booted.port, ALICE, table.gameId);
        const first = latestClock(alice) as RoomClockView;
        assert.equal(first.seat, table.playerIds[ALICE], "the deal's first acting seat");
        assert.deepEqual([first.state, first.mode, first.allowanceMs, first.remainingMs], ["running", "live", null, null], "no approved duration: counts up");
        await time.advance(40 * SEC);
        const bob = await tab(booted.port, BOB, table.gameId);
        const bobSees = latestClock(bob) as RoomClockView;
        assert.equal(bobSees.seat, table.playerIds[ALICE], "Bob is shown Alice's clock -- his own is not running");
        assert.equal(bobSees.elapsedMs, 40 * SEC);
        await buy(booted.port, ALICE, table.gameId, "a-buy");
        await settle(booted, table.gameId);
        const handed = await clockWhere(alice, (clock) => clock.seat === table.playerIds[BOB], "the clock handed to Bob");
        assert.equal(handed.elapsedMs, 0, "the new turn starts from zero");
        assert.equal(handed.turnStartedAt, time.now());
        await time.advance(15 * SEC);
        const later = await tab(booted.port, ALICE, table.gameId);
        assert.equal(latestClock(later)?.elapsedMs, 15 * SEC);
        assert.ok(booted.ops.lines.some((line) => line.event === "clock.turn" && line.seat === table.playerIds[ALICE] && line.active_ms === 40 * SEC), "the ended turn is instrumented");
        await Promise.all([alice.close(), bob.close(), later.close()]);
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("pause freezes the remaining time; resume continues from it; a reload, a reconnect and a second tab all read the server's clock", async () =>
    withDir("pause", async (dir) => {
      const time = fakeTime(Date.now());
      const booted = await boot(dir, time, TEST_POLICY);
      try {
        const table = await openGame(booted.port, ALICE, [BOB]);
        await settle(booted, table.gameId);
        const first = await tab(booted.port, ALICE, table.gameId);
        const second = await tab(booted.port, ALICE, table.gameId); // a second tab of the same player
        await time.advance(30 * SEC);
        const shown = await tab(booted.port, ALICE, table.gameId);
        assert.equal(latestClock(shown)?.remainingMs, 90 * SEC);
        const revision = (latestClock(shown) as RoomClockView).revision;
        const paused = await first.op({ type: "clock-pause", revision }, table.gameId);
        assert.equal(paused.ok, true, JSON.stringify(paused));
        const p1 = await clockWhere(first, (clock) => clock.state === "paused", "paused (first tab)");
        const p2 = await clockWhere(second, (clock) => clock.state === "paused", "paused (second tab)");
        assert.deepEqual([p2.revision, p2.remainingMs, p2.turnStartedAt], [p1.revision, p1.remainingMs, p1.turnStartedAt], "both tabs see one clock");
        await time.advance(20 * MIN);
        const reload = await tab(booted.port, ALICE, table.gameId); // a reload: a fresh tab
        assert.deepEqual([latestClock(reload)?.state, latestClock(reload)?.remainingMs], ["paused", 90 * SEC], "frozen while paused -- and no expiry");
        assert.equal(booted.ops.lines.filter((line) => line.event === "clock.expired").length, 0);
        const resumed = await second.op({ type: "clock-resume", revision: p2.revision }, table.gameId);
        assert.equal(resumed.ok, true, JSON.stringify(resumed));
        await clockWhere(first, (clock) => clock.state === "running", "running again");
        await time.advance(10 * SEC);
        /* A reconnect: every socket of the player gone, then back. The clock is not reset, and did not gain or lose. */
        await Promise.all([first.close(), second.close(), shown.close(), reload.close()]);
        await time.advance(5 * SEC);
        const back = await tab(booted.port, ALICE, table.gameId);
        const after = latestClock(back) as RoomClockView;
        assert.deepEqual([after.state, after.elapsedMs, after.remainingMs, after.serverNow], ["running", 45 * SEC, 75 * SEC, time.now()]);
        assert.ok(booted.ops.lines.some((line) => line.event === "clock.paused") && booted.ops.lines.some((line) => line.event === "clock.resumed"));
        await back.close();
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("a stale tab can neither pause, resume, reset nor advance the clock; a non-host cannot pause", async () =>
    withDir("stale", async (dir) => {
      const time = fakeTime(Date.now());
      const booted = await boot(dir, time, TEST_POLICY);
      try {
        const table = await openGame(booted.port, ALICE, [BOB]);
        await settle(booted, table.gameId);
        const fresh = await tab(booted.port, ALICE, table.gameId);
        const stale = await tab(booted.port, ALICE, table.gameId);
        const seen = (latestClock(stale) as RoomClockView).revision;
        stale.socket.pause(); // this tab stops reading: it keeps the clock it last saw
        await time.advance(20 * SEC);
        assert.equal((await fresh.op({ type: "clock-pause", revision: seen }, table.gameId)).ok, true);
        await settle(booted, table.gameId);
        const before = booted.server.rooms.clocks.recordOf(table.gameId) as NonNullable<ReturnType<typeof booted.server.rooms.clocks.recordOf>>;
        stale.socket.resume();
        for (const type of ["clock-resume", "clock-pause"]) {
          const answer = await stale.op({ type, revision: seen }, table.gameId);
          assert.deepEqual([answer.ok, answer.code], [false, "clock-stale"], `${type} from a stale tab`);
        }
        assert.deepEqual(booted.server.rooms.clocks.recordOf(table.gameId), before, "nothing moved");
        const bob = await tab(booted.port, BOB, table.gameId);
        const bobAnswer = await bob.op({ type: "clock-resume", revision: before.revision }, table.gameId);
        assert.deepEqual([bobAnswer.ok, bobAnswer.code], [false, "forbidden"], "only the host pauses or resumes (owner decision open)");
        /* A malformed or invented op is refused by the closed schema: no op names a time. */
        bob.send({ kind: "room-op", requestId: "x1", gameId: table.gameId, op: { type: "clock-pause", revision: before.revision, remainingMs: 999_999 } });
        await until(() => bob.frames.some((frame) => frame.kind === "error" && frame.code === "bad-frame"), "the invented field refused");
        assert.deepEqual(booted.server.rooms.clocks.recordOf(table.gameId), before);
        await Promise.all([fresh.close(), stale.close(), bob.close()]);
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("an UNDO cannot reset a clock: undoing the move that ended your turn resumes it with the time already used", async () =>
    withDir("undo", async (dir) => {
      const time = fakeTime(Date.now());
      const booted = await boot(dir, time, TEST_POLICY);
      try {
        const table = await openGame(booted.port, ALICE, [BOB]);
        await settle(booted, table.gameId);
        await time.advance(50 * SEC);
        const bought = await play(booted.port, ALICE, table.gameId, BUY, "a-buy");
        const buyIndex = (bought.entries as Array<{ index: number; actor: string }>).find((entry) => entry.actor === table.playerIds[ALICE])?.index as number;
        await settle(booted, table.gameId);
        const alice = await tab(booted.port, ALICE, table.gameId);
        await clockWhere(alice, (clock) => clock.seat === table.playerIds[BOB], "Bob's turn");
        await time.advance(20 * SEC);
        await play(booted.port, ALICE, table.gameId, { RevertTo: { index: buyIndex, player: "me", summary: "undo" } }, "a-undo");
        await settle(booted, table.gameId);
        const resumed = await clockWhere(alice, (clock) => clock.seat === table.playerIds[ALICE], "Alice's turn, resumed");
        assert.equal(resumed.elapsedMs, 50 * SEC, "the undone turn resumes with the 50 s it had used -- not a fresh allowance, not charged Bob's 20 s");
        assert.equal(resumed.remainingMs, 2 * MIN - 50 * SEC);
        await time.advance(10 * SEC);
        const later = await tab(booted.port, BOB, table.gameId);
        assert.equal(latestClock(later)?.elapsedMs, 60 * SEC);
        await Promise.all([alice.close(), later.close()]);
      } finally {
        await stopServer(booted.server);
      }
      /* And a restart after the undo keeps the resumed turn: the undone purchase is not a hand-over. */
      await time.advance(5 * SEC);
      const again = await boot(dir, time, TEST_POLICY);
      try {
        const games = (await createFileLogStore(dir, quiet).listGameLogs?.()) ?? [];
        const gameId = games[0] as string;
        const bob = await tab(again.port, BOB, gameId);
        assert.equal(latestClock(bob)?.elapsedMs, 65 * SEC, "the restart did not reset the resumed turn");
        await bob.close();
      } finally {
        await stopServer(again.server);
      }
    }));

  test("a server restart does not reset the clock: the same turn keeps its start, its pause and its paused total", async () =>
    withDir("restart", async (dir) => {
      const time = fakeTime(Date.now());
      let booted = await boot(dir, time, TEST_POLICY);
      let gameId = "";
      let playerIds: Record<string, string> = {};
      let turnStartedAt = 0;
      try {
        const table = await openGame(booted.port, ALICE, [BOB]);
        ({ gameId, playerIds } = table);
        await settle(booted, gameId);
        await time.advance(10 * SEC);
        await buy(booted.port, ALICE, gameId, "a-buy");
        await settle(booted, gameId);
        turnStartedAt = time.now();
        await time.advance(20 * SEC);
        const alice = await tab(booted.port, ALICE, gameId);
        assert.equal((await alice.op({ type: "clock-pause", revision: (latestClock(alice) as RoomClockView).revision }, gameId)).ok, true);
        await time.advance(5 * MIN);
        const resumed = await alice.op({ type: "clock-resume", revision: (await clockWhere(alice, (c) => c.state === "paused", "paused")).revision }, gameId);
        assert.equal(resumed.ok, true);
        await time.advance(10 * SEC);
        await alice.close();
        await settle(booted, gameId);
      } finally {
        await stopServer(booted.server);
      }
      assert.ok(fs.existsSync(path.join(clockDirectory(dir), `${gameId}.json`)), "the clock is durable beside the game");
      await time.advance(7 * SEC); // the server is down
      booted = await boot(dir, time, TEST_POLICY);
      try {
        const bob = await tab(booted.port, BOB, gameId);
        const clock = latestClock(bob) as RoomClockView;
        assert.equal(clock.seat, playerIds[BOB]);
        assert.equal(clock.turnStartedAt, turnStartedAt, "the turn's start survives the restart");
        assert.equal(clock.elapsedMs, 20 * SEC + 10 * SEC + 7 * SEC, "paused time stays uncharged; wall time runs on across the restart");
        assert.equal(clock.remainingMs, 2 * MIN - 37 * SEC);
        await bob.close();
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("Live and Async read different policy slots, each frozen into the table's clock", async () =>
    withDir("modes", async (dir) => {
      const time = fakeTime(Date.now());
      const booted = await boot(dir, time, TEST_POLICY);
      try {
        const live = await openTable(booted.port, { mode: "live" });
        const asyncTable = await openTable(booted.port, { mode: "async" });
        await settle(booted, live.gameId);
        await settle(booted, asyncTable.gameId);
        const a = await tab(booted.port, ALICE, live.gameId);
        const b = await tab(booted.port, ALICE, asyncTable.gameId);
        assert.deepEqual([latestClock(a)?.mode, latestClock(a)?.allowanceMs], ["live", 2 * MIN]);
        assert.deepEqual([latestClock(b)?.mode, latestClock(b)?.allowanceMs], ["async", 6 * 60 * MIN]);
        await Promise.all([a.close(), b.close()]);
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("EXPIRY: time expired is said and audited -- no gameplay is dispatched, nobody is forfeited, nothing is settled", async () =>
    withDir("expiry", async (dir) => {
      const time = fakeTime(Date.now());
      const booted = await boot(dir, time, TEST_POLICY);
      try {
        const table = await openGame(booted.port, ALICE, [BOB]);
        await settle(booted, table.gameId);
        const watcher = await Client.open(booted.port, BOB);
        watcher.hello(table.gameId);
        const catchUp = await watcher.next((frame) => frame.kind === "catch-up", "the catch-up");
        const alice = await tab(booted.port, ALICE, table.gameId);
        const logBefore = await createFileLogStore(dir, quiet).loadLog(table.gameId);
        const recordBefore = booted.server.records.load ? await booted.server.records.load(table.gameId) : null;
        const spiesBefore = { ...booted.spies };
        const framesBefore = watcher.frames.length;
        await time.advance(2 * MIN + SEC);
        await settle(booted, table.gameId);
        const pushed = await clockWhere(alice, (clock) => clock.state === "expired", "the expired clock, pushed when it ran out");
        assert.equal(pushed.serverNow - (pushed.turnStartedAt as number), pushed.elapsedMs);
        const fresh = await tab(booted.port, ALICE, table.gameId);
        const expired = latestClock(fresh) as RoomClockView;
        assert.deepEqual([expired.state, expired.seat, expired.remainingMs, expired.elapsedMs], ["expired", table.playerIds[ALICE], 0, 2 * MIN + SEC], "the same seat keeps its turn");
        await fresh.close();
        await time.advance(10 * MIN);
        await settle(booted, table.gameId);
        /* No gameplay dispatched: the log, the board and the record are exactly what they were. */
        const logAfter = await createFileLogStore(dir, quiet).loadLog(table.gameId);
        assert.deepEqual(logAfter, logBefore, "no entry was appended");
        assert.equal(watcher.frames.slice(framesBefore).filter((frame: Frame) => frame.kind === "applied" || frame.kind === "catch-up").length, 0, "no move was fanned out");
        const recordAfter = booted.server.records.load ? await booted.server.records.load(table.gameId) : null;
        assert.deepEqual(recordAfter, recordBefore, "the GameRecord is untouched (status, seats, host)");
        assert.equal((recordAfter as GameRecord).status, "active");
        watcher.hello(table.gameId, -1);
        const again = await watcher.next((frame) => frame.kind === "catch-up", "a fresh catch-up");
        assert.equal(again.digest, catchUp.digest, "the board is the same board");
        /* Nobody forfeited, nothing settled, the escrow seam never called. */
        assert.deepEqual(booted.spies, spiesBefore, "no settlement and no escrow call");
        const lines = booted.ops.lines.map((line) => JSON.stringify(line));
        assert.equal(lines.filter((line) => line.includes("clock.expired")).length, 1, "audited once");
        assert.equal(lines.some((line) => /forfeit|clemency|declin|succession|game\.sealed|settle/i.test(line)), false);
        /* The expired seat can still play: its move is accepted and hands the turn on as usual. */
        await buy(booted.port, ALICE, table.gameId, "late-buy");
        await settle(booted, table.gameId);
        const next = await clockWhere(alice, (clock) => clock.seat === table.playerIds[BOB], "the turn handed on after the late move");
        assert.equal(next.state, "running");
        await Promise.all([watcher.close(), alice.close()]);
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("GameEnd stops timing", async () =>
    withDir("end", async (dir) => {
      const time = fakeTime(Date.now());
      /* The LIVE-3C test seam: a board LONGER than `endAfter` entries reads as GameEnd (a real GameEnd needs a whole game). */
      let endAfter = Number.POSITIVE_INFINITY;
      const booted = await boot(dir, time, TEST_POLICY, { faults: { boardEnded: (_gameId, session) => session.entries.length > endAfter } });
      try {
        const table = await openGame(booted.port, ALICE, [BOB]);
        await settle(booted, table.gameId);
        await time.advance(30 * SEC);
        endAfter = (await createFileLogStore(dir, quiet).loadLog(table.gameId)).length; // the next committed board ends
        await buy(booted.port, ALICE, table.gameId, "final");
        await settle(booted, table.gameId);
        const alice = await tab(booted.port, ALICE, table.gameId);
        const stopped = await clockWhere(alice, (clock) => clock.state === "stopped", "the stopped clock");
        assert.equal(stopped.seat, null);
        await time.advance(60 * MIN);
        await settle(booted, table.gameId);
        const later = await tab(booted.port, ALICE, table.gameId);
        assert.deepEqual([latestClock(later)?.state, latestClock(later)?.elapsedMs], ["stopped", stopped.elapsedMs], "nothing counts after GameEnd");
        assert.equal(booted.ops.lines.filter((line) => line.event === "clock.expired").length, 0, "a stopped clock never expires");
        assert.ok(booted.ops.lines.some((line) => line.event === "clock.stopped"));
        await Promise.all([alice.close(), later.close()]);
      } finally {
        await stopServer(booted.server);
      }
    }));

  test("an existing game with no clock (a legacy record, no `mode`) stays readable and is timed from its last committed move", async () =>
    withDir("legacy", async (dir) => {
      const gameId = mintGameId();
      const log: ServerLogEntry[] = storedLog(1); // the deal and Alice's purchase: Bob is on turn
      const { mode: _dropped, ...legacyVariants } = seededRecord([ALICE, BOB]).variants as unknown as Record<string, unknown>;
      void _dropped;
      const record = { ...seededRecord([ALICE, BOB], { dealt: true, gameId }), rules_engine_version: RULES_ENGINE_VERSION, started_at: log[0].at ?? 0, variants: legacyVariants } as unknown as GameRecord;
      fs.mkdirSync(path.join(dir, "games"), { recursive: true });
      fs.writeFileSync(path.join(dir, "games", `${gameId}.json`), `${JSON.stringify(record)}\n`);
      fs.writeFileSync(path.join(dir, `${gameId}.log.jsonl`), log.map((entry) => serializeBatch([entry])).join(""));
      const time = fakeTime(Date.now());
      const booted = await boot(dir, time, undefined);
      try {
        const bob = await tab(booted.port, BOB, gameId);
        const clock = latestClock(bob) as RoomClockView;
        assert.equal(clock.mode, "live", "a record that names no mode reads as Live (#1256)");
        assert.equal(clock.seat, BOB);
        assert.equal(clock.turnStartedAt, log[log.length - 1].at, "timed from the hand-over's server stamp (Alice's purchase, the newest entry)");
        const stored = JSON.parse(fs.readFileSync(path.join(dir, "games", `${gameId}.json`), "utf8")) as GameRecord;
        assert.equal(stored.record_version, record.record_version, "the GameRecord itself is not rewritten for the clock");
        assert.equal(Object.prototype.hasOwnProperty.call(stored, "clock"), false);
        await settle(booted, gameId);
        assert.ok(fs.existsSync(path.join(clockDirectory(dir), `${gameId}.json`)), "the clock lives in its own record");
        await bob.close();
      } finally {
        await stopServer(booted.server);
      }
    }));
});
