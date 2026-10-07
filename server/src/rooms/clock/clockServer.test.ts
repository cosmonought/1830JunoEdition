// server/src/rooms/clock/clockServer.test.ts
//
// PHASE 3 FINAL CLOCKS: the table clock through the REAL server -- sockets, the room protocol, the file stores a
// deployment runs, restarts -- on CONTROLLED time (`clockTestSupport.ts`). Every duration is the owner's (20:00 per
// required action, 10:00 cure, Timed Async paces); nothing here shortens a clock.
//
//   Live          the seat that owes the next decision is timed; an accepted action hands a fresh 20:00 to whoever
//                 owes next; another seat's clock does not run; a second tab sees the same clock.
//   Overdue       at 20:00 the table is INTERRUPTED (only the overdue seat's owed action continues it); a cure before
//                 30:00 keeps the game; no cure and no complete N-1 approval -> neutral timeout annulment at 30:00;
//                 complete N-1 approval -> foreclosure at 30:00, decided at 30:00 only; one NO vetoes.
//   Pause         unanimous to pause, unanimous to resume, the remainder exact; moves refused while paused.
//   Continuity    a restart under a NEW authority (a new process) of a game still in play is a SYSTEM PAUSE: the
//                 outage is never charged, no overdue is created from it, and only every player's resume continues
//                 play. An ENDED game has nothing to resume: no pause, no vote (its sealed remedy is carried on).
//   Offers        no count of offers and no history length is a rule: offer FREQUENCY alone is bounded, as transport.
//   Async         the pace is the host's, fixed at the deal; expiry is OVERDUE only (no automatic outcome); the other
//                 N-1 annul or foreclose; No-deadline has no clock at all.
//   Annulment     a free table's unanimous annulment ends it in any state.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createFileLogStore } from "../../fileLogStore";
import type { GameServerOptions } from "../../gameServer";
import { createMemoryOpsRecorder, type MemoryOpsRecorder } from "../../persistence/opsRecorder";
import type { RoomClockView } from "../../../../frontend/src/utils/clockProtocol";
import { CLOCK_REFUSAL } from "../../../../frontend/src/utils/clockProtocol";
import { createFileHoldStore } from "../holdStore";
import { createFileRecordStore } from "../recordStore";
import { ALICE, BOB, BUY, CAROL, Client, PASS, quietConsole, sleep, startServer, stopServer, until, type Frame } from "../testSupport";
import { fakeTime, type FakeTime } from "./clockTestSupport";
import { createFileClockStore } from "./clockStore";
import { LIVE_ACTION_MS, LIVE_CURE_MS } from "./clockRecord";

quietConsole();

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const T0 = 1_780_000_000_000;
const quiet = { warn: () => undefined };

function withDir<T>(tag: string, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p3final-${tag}-`));
  return body(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

interface Booted {
  server: Awaited<ReturnType<typeof startServer>>["server"];
  port: number;
  ops: MemoryOpsRecorder;
}

/** A server over the FILE stores in `dir` (logs, records, holds, clocks), its clock on `time` under `authority`. */
async function boot(dir: string, time: FakeTime, authority: string, over: Partial<GameServerOptions> = {}): Promise<Booted> {
  const store = createFileLogStore(dir, quiet);
  if (store.loadChat) await store.loadChat("settle");
  const ops = createMemoryOpsRecorder();
  const { server, port } = await startServer({
    store,
    records: createFileRecordStore(dir, quiet),
    holds: createFileHoldStore(dir, quiet),
    clock: { store: createFileClockStore(dir, quiet), authority, now: time.now, timers: time.timers },
    ops,
    ...over,
  });
  await server.lifecycle.ready;
  time.drain = async () => {
    await server.clock?.idle();
  };
  return { server, port, ops };
}

const latestClock = (client: Client): RoomClockView | undefined => {
  const rooms = client.of("room");
  return (rooms[rooms.length - 1]?.view as { clock?: RoomClockView } | undefined)?.clock;
};

async function clockWhere(client: Client, check: (clock: RoomClockView) => boolean, label: string): Promise<RoomClockView> {
  await until(() => {
    const clock = latestClock(client);
    return clock !== undefined && check(clock);
  }, `${label} (last clock ${JSON.stringify(latestClock(client))})`);
  return latestClock(client) as RoomClockView;
}

/** A tab on the table: its room view (with the clock). */
async function tab(port: number, claim: string, gameId: string): Promise<Client> {
  const client = await Client.open(port, claim);
  client.roomHello(gameId);
  await clockWhere(client, () => true, `a clock for ${claim}`);
  return client;
}

const lastIndex = (client: Client): number => client.seen().reduce((max, entry) => Math.max(max, entry.index), -1);

/** One move through the seat's own log socket; the server's answer. */
async function submit(port: number, claim: string, gameId: string, msg: object, label: string): Promise<Frame> {
  const client = await Client.open(port, claim);
  client.hello(gameId);
  await client.next((frame) => frame.kind === "catch-up", "the catch-up");
  client.submit(msg, { baseIndex: lastIndex(client), submissionId: label });
  const answer = await client.answerTo(label);
  await client.close();
  return answer;
}

async function play(port: number, claim: string, gameId: string, msg: object, label: string): Promise<void> {
  const answer = await submit(port, claim, gameId, msg, label);
  assert.equal(answer.kind, "applied", `${label}: ${JSON.stringify(answer)}`);
}

async function op(port: number, claim: string, gameId: string, body: Record<string, unknown>): Promise<Frame> {
  const client = await Client.open(port, claim);
  const answer = await client.op(body, gameId);
  await client.close();
  return answer;
}

async function opOk(port: number, claim: string, gameId: string, body: Record<string, unknown>): Promise<void> {
  const answer = await op(port, claim, gameId, body);
  assert.equal(answer.ok, true, `${claim} ${String(body.type)}: ${JSON.stringify(answer)}`);
}

/** A table created with chosen variants, every seat taken and ready; the host deals unless `deal: false`. `before`
 *  runs between the ready marks and the deal (the host's deadline choice). */
async function openTable(
  port: number,
  claims: readonly string[],
  options: { variants?: Record<string, unknown>; deal?: boolean; before?: (gameId: string) => Promise<void> } = {},
): Promise<{ gameId: string; ids: Record<string, string> }> {
  const host = await Client.open(port, claims[0]);
  const created = await host.op({ type: "create", visibility: "public", exactPlayers: null, variants: options.variants ?? {}, nickname: claims[0] });
  assert.equal(created.ok, true, JSON.stringify(created));
  const { gameId, code, playerId } = created.data as { gameId: string; code: string; playerId: string };
  const ids: Record<string, string> = { [claims[0]]: playerId };
  const clients = [host];
  for (const claim of claims.slice(1)) {
    const guest = await Client.open(port, claim);
    clients.push(guest);
    const joined = await guest.op({ type: "join", code, takeSeat: true });
    assert.equal(joined.ok, true, JSON.stringify(joined));
    ids[claim] = (joined.data as { playerId: string }).playerId;
  }
  for (const client of clients) assert.equal((await client.op({ type: "set-ready", ready: true }, gameId)).ok, true);
  if (options.before !== undefined) await options.before(gameId);
  if (options.deal !== false) assert.equal((await host.op({ type: "start-game" }, gameId)).ok, true);
  await Promise.all(clients.map((client) => client.close()));
  return { gameId, ids };
}

const THREE = [ALICE, BOB, CAROL];

/* ==================================================================
    LIVE: THE ACTION CLOCK
   ================================================================== */

describe("Live action clock through the server", () => {
  test("the seat that owes the next decision is timed; an accepted action hands a fresh 20:00 to the next; every tab agrees", () =>
    withDir("live", async (dir) => {
      const time = fakeTime(T0);
      const { server, port } = await boot(dir, time, "auth-1");
      try {
        const { gameId, ids } = await openTable(port, THREE);
        const watcher = await tab(port, CAROL, gameId);
        const first = await clockWhere(watcher, (c) => c.state === "running" && c.responsible !== null, "the first obligation");
        assert.deepEqual([first.deadline, first.responsible?.seat, first.action?.remainingMs, first.action?.running], ["live", ids[ALICE], LIVE_ACTION_MS, true]);
        assert.deepEqual(first.strikes, {});
        await time.advance(7 * MIN);
        await play(port, ALICE, gameId, BUY, "a-buys");
        const second = await clockWhere(watcher, (c) => c.responsible?.seat === ids[BOB], "Bob owes next");
        assert.equal(second.action?.remainingMs, LIVE_ACTION_MS, "a fresh 20:00 for the next required action (never Alice's remainder)");
        const other = await tab(port, BOB, gameId);
        const seen = await clockWhere(other, (c) => c.responsible?.seat === ids[BOB], "the second tab");
        assert.deepEqual([seen.revision, seen.action?.remainingMs], [second.revision, second.action?.remainingMs], "a second tab sees the same clock");
        await Promise.all([watcher.close(), other.close()]);
      } finally {
        await stopServer(server);
      }
    }));

  test("20:00 -> OVERDUE (strike 1); the table is interrupted; a cure before 30:00 continues the game and keeps the strike", () =>
    withDir("cure", async (dir) => {
      const time = fakeTime(T0);
      const { server, port, ops } = await boot(dir, time, "auth-1");
      try {
        const { gameId, ids } = await openTable(port, THREE);
        const watcher = await tab(port, CAROL, gameId);
        await time.advance(LIVE_ACTION_MS);
        const od = await clockWhere(watcher, (c) => c.state === "overdue", "Alice overdue");
        assert.deepEqual([od.overdue?.seat, od.overdue?.strike, od.overdue?.finality?.remainingMs, od.overdue?.outcomeIfUncured], [ids[ALICE], 1, LIVE_CURE_MS, "timeout-annul"]);
        assert.deepEqual(od.strikes, { [ids[ALICE]]: 1 });
        assert.ok(ops.lines.some((a) => a.event === "clock.overdue"), "the overdue is audited");
        const refused = await submit(port, BOB, gameId, BUY, "b-interrupts");
        assert.equal(refused.kind, "refused");
        assert.equal(refused.code, CLOCK_REFUSAL.interrupted, JSON.stringify(refused));
        await time.advance(8 * MIN);
        await play(port, ALICE, gameId, BUY, "a-cures");
        const cured = await clockWhere(watcher, (c) => c.state === "running" && c.responsible?.seat === ids[BOB], "cured");
        assert.equal(cured.overdue, null);
        assert.deepEqual(cured.strikes, { [ids[ALICE]]: 1 }, "a cure never erases the strike");
        await time.advance(2 * MIN + SEC);
        const after = await clockWhere(watcher, (c) => c.revision >= cured.revision, "nothing at the old finality");
        assert.equal(after.ended, null);
        await watcher.close();
      } finally {
        await stopServer(server);
      }
    }));

  test("no cure and no approval: neutral timeout annulment at exactly 30:00; every later move is refused", () =>
    withDir("annul30", async (dir) => {
      const time = fakeTime(T0);
      const { server, port } = await boot(dir, time, "auth-1");
      try {
        const { gameId, ids } = await openTable(port, THREE);
        const watcher = await tab(port, BOB, gameId);
        await time.advance(LIVE_ACTION_MS + LIVE_CURE_MS);
        const ended = await clockWhere(watcher, (c) => c.state === "ended", "ended at 30:00");
        assert.deepEqual(ended.ended, { kind: "live-timeout-annul", at: T0 + LIVE_ACTION_MS + LIVE_CURE_MS, seat: ids[ALICE] });
        const late = await submit(port, ALICE, gameId, BUY, "a-too-late");
        assert.equal(late.code, CLOCK_REFUSAL.ended, JSON.stringify(late));
        const stored = JSON.parse(fs.readFileSync(path.join(dir, "games", "clocks", `${gameId}.json`), "utf8")) as { phase: string; ended: { kind: string } };
        assert.deepEqual([stored.phase, stored.ended.kind], ["ended", "live-timeout-annul"], "the outcome is durable");
        await watcher.close();
      } finally {
        await stopServer(server);
      }
    }));

  test("complete N-1 approval decides only the minute-30 outcome (foreclosure); one NO vetoes; the owed seat is never asked", () =>
    withDir("foreclose", async (dir) => {
      const time = fakeTime(T0);
      const { server, port } = await boot(dir, time, "auth-1");
      try {
        const { gameId, ids } = await openTable(port, THREE);
        const watcher = await tab(port, CAROL, gameId);
        await time.advance(LIVE_ACTION_MS + 2 * MIN);
        await clockWhere(watcher, (c) => c.state === "overdue", "overdue");
        const selfVote = await op(port, ALICE, gameId, { type: "clock-propose", kind: "foreclose" });
        assert.equal(selfVote.ok, false, "the overdue seat cannot propose against itself");
        const neutral = await op(port, BOB, gameId, { type: "clock-propose", kind: "annul" });
        assert.equal(neutral.ok, false, "Live: the vote is only about foreclosure (neutral is automatic)");
        await opOk(port, BOB, gameId, { type: "clock-propose", kind: "foreclose" });
        let view = await clockWhere(watcher, (c) => c.overdue?.proposal !== null && c.overdue?.proposal !== undefined, "a proposal");
        await opOk(port, CAROL, gameId, { type: "clock-vote", proposalId: view.overdue!.proposal!.id, yes: false });
        view = await clockWhere(watcher, (c) => c.overdue?.proposal === null, "vetoed");
        assert.equal(view.overdue?.finality?.remainingMs, LIVE_CURE_MS - 2 * MIN, "finality neither reset nor extended");
        await opOk(port, BOB, gameId, { type: "clock-propose", kind: "foreclose" });
        view = await clockWhere(watcher, (c) => c.overdue?.proposal !== null && c.overdue?.proposal !== undefined, "a second proposal");
        await opOk(port, CAROL, gameId, { type: "clock-vote", proposalId: view.overdue!.proposal!.id, yes: true });
        view = await clockWhere(watcher, (c) => c.overdue?.proposal?.complete === true, "complete N-1");
        assert.equal(view.state, "overdue", "complete approval does not execute early");
        assert.equal(view.overdue?.outcomeIfUncured, "foreclosure");
        await time.advance(LIVE_CURE_MS - 2 * MIN);
        const ended = await clockWhere(watcher, (c) => c.state === "ended", "foreclosed at 30:00");
        assert.deepEqual(ended.ended, { kind: "live-foreclosure", at: T0 + LIVE_ACTION_MS + LIVE_CURE_MS, seat: ids[ALICE] });
        await watcher.close();
      } finally {
        await stopServer(server);
      }
    }));
});

describe("Only an accepted required action refreshes the clock", () => {
  test("a refused move, a duplicate retry, chat, a reconnect and a second tab never refresh or reset it", () =>
    withDir("norefresh", async (dir) => {
      const time = fakeTime(T0);
      const { server, port } = await boot(dir, time, "auth-1");
      try {
        const { gameId, ids } = await openTable(port, THREE);
        await time.advance(5 * MIN);
        const offTurn = await submit(port, BOB, gameId, BUY, "b-off-turn");
        assert.equal(offTurn.kind, "refused", "not Bob's decision");
        const chatter = await tab(port, CAROL, gameId);
        chatter.send({ kind: "chat-send", gameId, text: "hurry up" });
        await time.advance(MIN);
        let view = await clockWhere(chatter, (c) => c.responsible !== null, "the clock");
        assert.equal(view.responsible?.seat, ids[ALICE]);
        assert.equal((view.action?.remainingMs ?? 0) + (view.serverNow - T0), LIVE_ACTION_MS, "the clock that began at the deal was never refreshed");
        /* Alice's move, then the SAME submission retried (a lost answer): one refresh, never two. */
        const mover = await Client.open(port, ALICE);
        mover.hello(gameId);
        await mover.next((frame) => frame.kind === "catch-up", "the catch-up");
        const base = lastIndex(mover);
        mover.submit(BUY, { baseIndex: base, submissionId: "a-once" });
        assert.equal((await mover.answerTo("a-once")).kind, "applied");
        await time.advance(3 * MIN);
        mover.submit(BUY, { baseIndex: base, submissionId: "a-once" });
        const retry = await mover.answerTo("a-once");
        assert.notEqual(retry.kind, "applied", `a retry is never a second action (${retry.kind})`);
        await mover.close();
        const fresh = await tab(port, BOB, gameId); // a reconnect / another tab
        view = await clockWhere(fresh, (c) => c.responsible?.seat === ids[BOB], "Bob owes next");
        assert.equal((view.action?.remainingMs ?? 0) + (view.serverNow - (T0 + 6 * MIN)), LIVE_ACTION_MS, "Bob's clock began at Alice's move; the retry and the new tab reset nothing");
        assert.ok(view.serverNow >= T0 + 9 * MIN);
        await Promise.all([chatter.close(), fresh.close()]);
      } finally {
        await stopServer(server);
      }
    }));

  test("multi-tab votes: a duplicate YES is idempotent, a NO from another tab vetoes, a vote for a stale proposal is refused", () =>
    withDir("multitab", async (dir) => {
      const time = fakeTime(T0);
      const { server, port } = await boot(dir, time, "auth-1");
      try {
        const { gameId } = await openTable(port, THREE);
        const watcher = await tab(port, ALICE, gameId);
        await time.advance(LIVE_ACTION_MS + MIN);
        await clockWhere(watcher, (c) => c.state === "overdue", "overdue");
        await opOk(port, BOB, gameId, { type: "clock-propose", kind: "foreclose" });
        const first = await clockWhere(watcher, (c) => c.overdue?.proposal !== null && c.overdue?.proposal !== undefined, "proposal 1");
        const id = first.overdue!.proposal!.id;
        const [tabA, tabB] = await Promise.all([Client.open(port, CAROL), Client.open(port, CAROL)]);
        const [yesA, yesB] = await Promise.all([tabA.op({ type: "clock-vote", proposalId: id, yes: true }, gameId), tabB.op({ type: "clock-vote", proposalId: id, yes: true }, gameId)]);
        assert.deepEqual([yesA.ok, yesB.ok], [true, true], "the same YES twice changes nothing the second time");
        let view = await clockWhere(watcher, (c) => c.overdue?.proposal?.complete === true, "complete");
        assert.deepEqual(view.overdue?.proposal?.yes.length, 2);
        assert.equal((await tabB.op({ type: "clock-vote", proposalId: id, yes: false }, gameId)).ok, true, "a seat may withdraw its YES before finality");
        view = await clockWhere(watcher, (c) => c.overdue?.proposal === null, "vetoed");
        const stale = await tabA.op({ type: "clock-vote", proposalId: id, yes: true }, gameId);
        assert.equal(stale.ok, false);
        assert.equal(stale.code, CLOCK_REFUSAL.stale, "a stale tab's vote for a closed proposal is refused");
        const outsider = await op(port, "p-mallory", gameId, { type: "clock-vote", proposalId: id, yes: true });
        assert.equal(outsider.ok, false, "a non-seated principal never votes");
        await Promise.all([tabA.close(), tabB.close(), watcher.close()]);
      } finally {
        await stopServer(server);
      }
    }));
});

/* ==================================================================
    PAUSE AND CONTINUITY
   ================================================================== */

describe("Voluntary pause and system pause through the server", () => {
  test("unanimous pause freezes the remainder exactly; moves are refused; unanimous resume continues it", () =>
    withDir("pause", async (dir) => {
      const time = fakeTime(T0);
      const { server, port } = await boot(dir, time, "auth-1");
      try {
        const { gameId, ids } = await openTable(port, THREE);
        const watcher = await tab(port, CAROL, gameId);
        await time.advance(13 * MIN + 48 * SEC);
        await opOk(port, BOB, gameId, { type: "clock-pause", action: "request", kind: "pause" });
        let view = await clockWhere(watcher, (c) => c.pause.request !== null, "a pause request");
        assert.equal(view.state, "running", "one request is not a pause");
        const id = view.pause.request!.id;
        await opOk(port, ALICE, gameId, { type: "clock-pause", action: "yes", kind: "pause", id });
        await opOk(port, CAROL, gameId, { type: "clock-pause", action: "yes", kind: "pause", id });
        view = await clockWhere(watcher, (c) => c.state === "paused", "paused");
        assert.deepEqual([view.action?.remainingMs, view.action?.running], [6 * MIN + 12 * SEC, false]);
        const refused = await submit(port, ALICE, gameId, BUY, "a-while-paused");
        assert.equal(refused.code, CLOCK_REFUSAL.paused, JSON.stringify(refused));
        await time.advance(3 * HOUR);
        await opOk(port, ALICE, gameId, { type: "clock-pause", action: "request", kind: "resume" });
        view = await clockWhere(watcher, (c) => c.pause.request?.kind === "resume", "a resume request");
        await opOk(port, BOB, gameId, { type: "clock-pause", action: "yes", kind: "resume", id: view.pause.request!.id });
        await opOk(port, CAROL, gameId, { type: "clock-pause", action: "yes", kind: "resume", id: view.pause.request!.id });
        view = await clockWhere(watcher, (c) => c.state === "running", "resumed");
        assert.deepEqual([view.responsible?.seat, view.action?.remainingMs], [ids[ALICE], 6 * MIN + 12 * SEC], "the three hours were never charged");
        await time.advance(6 * MIN + 12 * SEC);
        await clockWhere(watcher, (c) => c.state === "overdue", "the remainder runs out exactly");
        await watcher.close();
      } finally {
        await stopServer(server);
      }
    }));

  test("a restart under a new authority is a SYSTEM PAUSE: the outage is never charged, never an overdue; unanimous resume", () =>
    withDir("system", async (dir) => {
      const time = fakeTime(T0);
      let booted = await boot(dir, time, "auth-1");
      let gameId = "";
      let ids: Record<string, string> = {};
      try {
        ({ gameId, ids } = await openTable(booted.port, THREE));
        await time.advance(6 * MIN);
        await play(booted.port, ALICE, gameId, BUY, "a-buys");
      } finally {
        await stopServer(booted.server);
      }
      time.jump(5 * HOUR); // the outage: no process ran; Bob's 20:00 would have expired many times over
      booted = await boot(dir, time, "auth-2");
      try {
        const watcher = await tab(booted.port, CAROL, gameId);
        let view = await clockWhere(watcher, (c) => c.state === "system-paused", "system pause");
        assert.equal(view.system?.preservedAt, T0 + 6 * MIN, "preserved as of the last proven instant");
        assert.deepEqual([view.responsible?.seat, view.action?.remainingMs, view.action?.running], [ids[BOB], LIVE_ACTION_MS, false]);
        assert.deepEqual(view.strikes, {}, "no strike from an outage");
        assert.ok(booted.ops.lines.some((a) => a.event === "clock.continuity-break"));
        const refused = await submit(booted.port, BOB, gameId, BUY, "b-during-system-pause");
        assert.equal(refused.code, CLOCK_REFUSAL.systemPaused, JSON.stringify(refused));
        await time.advance(2 * HOUR);
        view = await clockWhere(watcher, (c) => c.state === "system-paused", "recovery is not resume");
        assert.equal(view.action?.remainingMs, LIVE_ACTION_MS);
        /* Each YES names the break the player looked at (`since`, required by the closed schema). */
        const since = view.system?.since as number;
        await opOk(booted.port, ALICE, gameId, { type: "clock-sysresume", since });
        await opOk(booted.port, BOB, gameId, { type: "clock-sysresume", since });
        view = await clockWhere(watcher, (c) => (c.system?.yes.length ?? 0) === 2, "two of three");
        assert.equal(view.state, "system-paused");
        await opOk(booted.port, CAROL, gameId, { type: "clock-sysresume", since });
        view = await clockWhere(watcher, (c) => c.state === "running", "every player resumed");
        assert.deepEqual([view.responsible?.seat, view.action?.remainingMs], [ids[BOB], LIVE_ACTION_MS]);
        await play(booted.port, BOB, gameId, BUY, "b-buys");
        await clockWhere(watcher, (c) => c.responsible?.seat === ids[CAROL], "play continues");
        await watcher.close();
      } finally {
        await stopServer(booted.server);
      }
    }));
});

/* ==================================================================
    TIMED ASYNC, NO-DEADLINE, ANNULMENT
   ================================================================== */

describe("Timed Async, No-deadline and annulment through the server", () => {
  test("Timed Async: the host's pace fixed at the deal; expiry is OVERDUE only; the other N-1 annul it", () =>
    withDir("async", async (dir) => {
      const time = fakeTime(T0);
      const { server, port } = await boot(dir, time, "auth-1");
      try {
        const { gameId, ids } = await openTable(port, THREE, {
          variants: { mode: "async" },
          before: async (id) => {
            const live = await op(port, ALICE, id, { type: "clock-policy", deadline: "live" });
            assert.equal(live.ok, false, "an Async table is never Live");
            const guest = await op(port, BOB, id, { type: "clock-policy", deadline: "async-pace", paceSecs: 86_400 });
            assert.equal(guest.ok, false, "only the host chooses");
            await opOk(port, ALICE, id, { type: "clock-policy", deadline: "async-pace", paceSecs: 43_200 });
          },
        });
        const watcher = await tab(port, CAROL, gameId);
        let view = await clockWhere(watcher, (c) => c.state === "running", "running");
        assert.deepEqual([view.deadline, view.paceSecs, view.policyFrozen, view.action?.remainingMs], ["async-pace", 43_200, true, 12 * HOUR]);
        const late = await op(port, ALICE, gameId, { type: "clock-policy", deadline: "async-pace", paceSecs: 604_800 });
        assert.equal(late.ok, false, "the pace is fixed once play begins");
        await time.advance(12 * HOUR);
        view = await clockWhere(watcher, (c) => c.state === "overdue", "overdue");
        assert.deepEqual([view.overdue?.seat, view.overdue?.strike, view.overdue?.finality, view.overdue?.outcomeIfUncured], [ids[ALICE], 0, null, null]);
        await time.advance(30 * 24 * HOUR);
        view = await clockWhere(watcher, (c) => c.state === "overdue", "still only overdue -- no automatic outcome");
        assert.equal(view.ended, null);
        await opOk(port, BOB, gameId, { type: "clock-propose", kind: "annul" });
        view = await clockWhere(watcher, (c) => c.overdue?.proposal !== null && c.overdue?.proposal !== undefined, "proposed");
        await opOk(port, CAROL, gameId, { type: "clock-vote", proposalId: view.overdue!.proposal!.id, yes: true });
        view = await clockWhere(watcher, (c) => c.state === "ended", "annulled at once");
        assert.equal(view.ended?.kind, "async-annul");
        await watcher.close();
      } finally {
        await stopServer(server);
      }
    }));

  test("No-deadline: no clock and no overdue, ever", () =>
    withDir("nodeadline", async (dir) => {
      const time = fakeTime(T0);
      const { server, port } = await boot(dir, time, "auth-1");
      try {
        const { gameId, ids } = await openTable(port, [ALICE, BOB], {
          variants: { mode: "async" },
          before: (id) => opOk(port, ALICE, id, { type: "clock-policy", deadline: "no-deadline" }),
        });
        const watcher = await tab(port, BOB, gameId);
        await time.advance(2 * 24 * HOUR);
        const view = await clockWhere(watcher, (c) => c.state === "running", "running");
        assert.deepEqual([view.deadline, view.action, view.overdue, view.responsible?.seat], ["no-deadline", null, null, ids[ALICE]]);
        await watcher.close();
      } finally {
        await stopServer(server);
      }
    }));

  test("a free table's unanimous annulment ends it in any state (here: overdue)", () =>
    withDir("annul", async (dir) => {
      const time = fakeTime(T0);
      const { server, port } = await boot(dir, time, "auth-1");
      try {
        const { gameId } = await openTable(port, [ALICE, BOB]);
        const watcher = await tab(port, BOB, gameId);
        await time.advance(LIVE_ACTION_MS + MIN);
        await clockWhere(watcher, (c) => c.state === "overdue", "overdue");
        await opOk(port, ALICE, gameId, { type: "clock-annul", yes: true });
        let view = await clockWhere(watcher, (c) => c.annul !== null, "one YES");
        assert.equal(view.state, "overdue");
        await opOk(port, BOB, gameId, { type: "clock-annul", yes: true });
        view = await clockWhere(watcher, (c) => c.state === "ended", "annulled");
        assert.equal(view.ended?.kind, "annulled");
        await watcher.close();
      } finally {
        await stopServer(server);
      }
    }));
});

/* ==================================================================
    OFFERS: NO COUNT, NO HISTORY BOUND -- FREQUENCY ONLY, AS TRANSPORT (owner, 2026-10-06)
   ================================================================== */

describe("Offers through the server: no game-rule cap, no history bound; frequency is transport", () => {
  const TWO = [ALICE, BOB];

  /** Plays a dealt two-seat table to its SECOND Stock Round (private trades are allowed from there): the waterfall
   *  auction bought out, the B&O par set, the first Stock Round passed (its empty Operating Rounds pass at once).
   *  Returns the seat on turn there and a private it owns. */
  async function toSecondStockRound(port: number, gameId: string, ids: Record<string, string>, _watcher: Client): Promise<{ seller: string; buyer: string; privateId: number }> {
    let n = 0;
    /* Whoever may make this move makes it (the other seat's attempt is refused and changes nothing). */
    const either = async (msg: (claim: string) => object, label: string): Promise<string | null> => {
      for (const claim of TWO) {
        const answer = await submit(port, claim, gameId, msg(claim), `${label}-${(n += 1)}`);
        if (answer.kind === "applied") return claim;
      }
      return null;
    };
    for (let bought = 0; bought < 6; ) {
      if ((await either(() => BUY, "buy")) !== null) {
        bought += 1;
        continue;
      }
      assert.notEqual(await either((claim) => ({ SetBoPar: { player: ids[claim], par_value: "100" } }), "bo-par"), null, "the auction waits on the B&O par");
    }
    await either((claim) => ({ SetBoPar: { player: ids[claim], par_value: "100" } }), "bo-par-late");
    await play(port, ALICE, gameId, { OpenStockRound: {} }, "open-sr");
    for (let pass = 0; pass < 2; pass += 1) assert.notEqual(await either(() => PASS, "sr1-pass"), null, "the first Stock Round passes");
    /* A private the seller (the seat on turn) owns: the engine refuses every other offer (and a refused offer spends
       nothing). */
    for (const seller of TWO) {
      const buyer = seller === ALICE ? BOB : ALICE;
      for (let privateId = 1; privateId <= 6; privateId += 1) {
        const tried = await submit(port, seller, gameId, { ProposePrivateTrade: { game_id: 0, private_id: privateId, seller: ids[seller], buyer: ids[buyer], price: 10 } }, `probe-${(n += 1)}`);
        if (tried.kind === "applied") {
          await play(port, seller, gameId, { RescindPrivateTrade: { game_id: 0, private_id: privateId } }, `probe-rescind-${n}`);
          return { seller, buyer, privateId };
        }
      }
    }
    throw new Error("no seat could offer a private");
  }

  const offer = (privateId: number, sellerId: string, buyerId: string) => ({ ProposePrivateTrade: { game_id: 0, private_id: privateId, seller: sellerId, buyer: buyerId, price: 10 } });

  test("NO 16 CAP: well over 16 legal offers in one Stock Round are each taken through the real server (Live table); none is refused by any game rule", () =>
    withDir("offers-nocap", async (dir) => {
      const time = fakeTime(T0);
      const { server, port } = await boot(dir, time, "auth-1", { limits: { rooms: { offersPerSeat: { capacity: 1e6, refillPerSecond: 1e6 }, offersPerSeatSustained: { capacity: 1e6, refillPerSecond: 1e6 } } } });
      try {
        const { gameId, ids } = await openTable(port, TWO);
        const watcher = await tab(port, ALICE, gameId);
        const { seller, buyer, privateId } = await toSecondStockRound(port, gameId, ids, watcher);
        for (let n = 1; n <= 20; n += 1) {
          await play(port, seller, gameId, offer(privateId, ids[seller], ids[buyer]), `offer-${n}`);
          const view = await clockWhere(watcher, (c) => c.state === "trade", `offer ${n} standing`);
          assert.equal(view.trade?.recipient, ids[buyer], "the Live 10:00 response timer runs for the answerer");
          await play(port, seller, gameId, { RescindPrivateTrade: { game_id: 0, private_id: privateId } }, `rescind-${n}`);
        }
        await watcher.close();
      } finally {
        await stopServer(server);
      }
    }));

  test("frequency is transport: past a burst of landed offers the next answers rate-limited WITH its wait (never a game rule) and is taken once it passes; a refused proposal spends nothing; the history's length is never a rule", () =>
    withDir("offers-rate", async (dir) => {
      const time = fakeTime(T0);
      const { server, port } = await boot(dir, time, "auth-1", { limits: { logEntryAlarm: 1, rooms: { offersPerSeat: { capacity: 3, refillPerSecond: 20 }, offersPerSeatSustained: { capacity: 1e6, refillPerSecond: 1e6 } } } });
      try {
        const { gameId, ids } = await openTable(port, TWO);
        const watcher = await tab(port, ALICE, gameId);
        const { seller, buyer, privateId } = await toSecondStockRound(port, gameId, ids, watcher);
        /* The probe's refused offers spent nothing; its one landed offer spent one token: two remain. */
        for (let n = 1; n <= 2; n += 1) {
          await play(port, seller, gameId, offer(privateId, ids[seller], ids[buyer]), `landed-${n}`);
          await play(port, seller, gameId, { RescindPrivateTrade: { game_id: 0, private_id: privateId } }, `landed-rescind-${n}`);
        }
        const limited = await submit(port, seller, gameId, offer(privateId, ids[seller], ids[buyer]), "limited");
        assert.equal(limited.code, "rate-limited", JSON.stringify(limited));
        assert.ok(typeof limited.retryAfterMs === "number" && (limited.retryAfterMs as number) > 0, "a transport answer: it says when to try again");
        assert.match(String(limited.reason), /too quickly/);
        assert.notEqual(limited.code, "log-nearly-full", "the history (past the alarm here) is never a rule");
        await sleep((limited.retryAfterMs as number) + 60);
        await play(port, seller, gameId, offer(privateId, ids[seller], ids[buyer]), "after-wait");
        await watcher.close();
      } finally {
        await stopServer(server);
      }
    }));

  test("ASYNC: repeated rejected offers stay available (no decline limit, no 10:00 response timer); LIVE: the third offer after two declines that round is refused, the reverse direction is open", () =>
    withDir("offers-declines", async (dir) => {
      const time = fakeTime(T0);
      const { server, port } = await boot(dir, time, "auth-1");
      try {
        const paced = await openTable(port, TWO, { variants: { mode: "async" }, before: async (id) => opOk(port, ALICE, id, { type: "clock-policy", deadline: "async-pace", paceSecs: 86_400 }) });
        const watcher = await tab(port, ALICE, paced.gameId);
        const a = await toSecondStockRound(port, paced.gameId, paced.ids, watcher);
        for (let n = 1; n <= 4; n += 1) {
          await play(port, a.seller, paced.gameId, offer(a.privateId, paced.ids[a.seller], paced.ids[a.buyer]), `async-offer-${n}`);
          const view = await clockWhere(watcher, (c) => c.responsible?.seat === paced.ids[a.buyer], `async offer ${n} owed`);
          assert.deepEqual([view.trade, view.action?.remainingMs], [null, 86_400_000], "an ordinary pace obligation, no response timer");
          await play(port, a.buyer, paced.gameId, { AnswerPrivateTrade: { game_id: 0, private_id: a.privateId, accept: false } }, `async-reject-${n}`);
        }
        assert.deepEqual((await clockWhere(watcher, () => true, "the Async clock")).declines, [], "no decline count in Async");
        await watcher.close();

        const live = await openTable(port, TWO);
        const liveWatcher = await tab(port, ALICE, live.gameId);
        const b = await toSecondStockRound(port, live.gameId, live.ids, liveWatcher);
        for (let n = 1; n <= 2; n += 1) {
          await play(port, b.seller, live.gameId, offer(b.privateId, live.ids[b.seller], live.ids[b.buyer]), `live-offer-${n}`);
          await play(port, b.buyer, live.gameId, { AnswerPrivateTrade: { game_id: 0, private_id: b.privateId, accept: false } }, `live-reject-${n}`);
        }
        const third = await submit(port, b.seller, live.gameId, offer(b.privateId, live.ids[b.seller], live.ids[b.buyer]), "live-offer-3");
        assert.equal(third.code, CLOCK_REFUSAL.declines, JSON.stringify(third));
        assert.match(String(third.reason), /has declined two offers from you/);
        await liveWatcher.close();
      } finally {
        await stopServer(server);
      }
    }));
});
