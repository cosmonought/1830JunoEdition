// server/src/rooms/phase3ClockModel.test.ts
//
// PHASE 3 LANE A (AUD-11.04): the gameplay clock's model -- the facts read off a committed board, the durable record and
// its transitions, the per-mode policy slots, the stores (memory, file), the keeper on CONTROLLED time, and the structural
// proof that the clock modules reach nothing of gameplay, escrow or settlement. The server-level behaviour (sockets,
// restarts, tabs) is `phase3Clock.test.ts`.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { createMemoryOpsRecorder } from "../persistence/opsRecorder";
import { createClockKeeper } from "./clockKeeper";
import { fakeTime as fakeTimeAt } from "./clockTestSupport";
import {
  clockFactsOf,
  clockPolicyFromEnv,
  clockViewOf,
  createFileClockStore,
  createMemoryClockStore,
  elapsedOf,
  isGameClockRecord,
  msUntilExpiry,
  newClockRecord,
  noteExpiry,
  observeFacts,
  pauseClock,
  vouchTurn,
  resumeClock,
  ClockUnreadableError,
  NO_APPROVED_CLOCK_POLICY,
  type ClockFacts,
  type ClockPolicy,
  type GameClockRecord,
} from "./gameClock";
import { mintGameId } from "./gameRecord";
import { ALICE, BOB, BUILD, BUY, probeSession, quietConsole, SETUP } from "./testSupport";

quietConsole();

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const TEST_POLICY: ClockPolicy = { live: { turnAllowanceMs: 2 * MIN }, async: { turnAllowanceMs: 24 * 60 * MIN } };

/** A committed board after the deal and `buys` purchases (ALICE first), as the server's session holds it. */
function boardAfter(buys: number) {
  const session = probeSession("clock");
  session.submit({ actor: ALICE, build: BUILD, msg: SETUP as never, baseIndex: -1, submissionId: "deal" });
  for (let n = 0; n < buys; n += 1) {
    const seat = session.state.player_addresses[n % 2];
    const result = session.submit({ actor: seat, build: BUILD, msg: BUY as never, baseIndex: session.nextIndex - 1, submissionId: `buy-${n}` });
    assert.equal(result.kind, "applied");
  }
  return session;
}

const fakeTime = () => fakeTimeAt(T0);

const factsAfter = (buys: number, board = { ended: false, closed: false }): ClockFacts => {
  const session = boardAfter(buys);
  return clockFactsOf({ state: session.state, entries: session.entries }, board);
};

describe("Phase 3 lane A: the facts a committed board gives the clock", () => {
  test("the acting seat is the engine's (the deal's first seat, then the next after a purchase); the key names the turn", () => {
    const dealt = factsAfter(0);
    assert.equal(dealt.dealt, true);
    assert.equal(dealt.seat, ALICE, "the clock starts on the seat the engine says is acting");
    const afterBuy = factsAfter(1);
    assert.equal(afterBuy.seat, BOB, "a purchase hands the turn -- and the clock -- to the next seat");
    assert.notEqual(afterBuy.turnKey, dealt.turnKey);
    assert.equal(afterBuy.watermark > dealt.watermark, true);
    assert.equal(typeof afterBuy.lastAt, "number");
  });

  test("an undealt board, GameEnd and a closed room time nobody", () => {
    const undealt = probeSession("undealt");
    assert.deepEqual(clockFactsOf({ state: undealt.state, entries: undealt.entries }, { ended: false, closed: false }).seat, null);
    const ended = factsAfter(1, { ended: true, closed: false });
    assert.equal(ended.seat, null);
    assert.equal(ended.ended, true);
    const closed = factsAfter(1, { ended: false, closed: true });
    assert.equal(closed.seat, null);
    assert.equal(closed.closed, true);
  });
});

describe("Phase 3 lane A: the policy slots -- no approved duration, owner-gated configuration", () => {
  test("the shipped default sets no duration for either mode", () => {
    assert.deepEqual(NO_APPROVED_CLOCK_POLICY, { live: { turnAllowanceMs: null }, async: { turnAllowanceMs: null } });
    const read = clockPolicyFromEnv({});
    assert.equal(read.ok, true);
    assert.deepEqual(read.ok && read.policy, NO_APPROVED_CLOCK_POLICY);
  });

  test("Live and Async are separate slots; values are whole seconds; anything else is refused, never guessed", () => {
    const read = clockPolicyFromEnv({ GS_CLOCK_LIVE_TURN_SECONDS: "90", GS_CLOCK_ASYNC_TURN_SECONDS: "86400" });
    assert.equal(read.ok, true);
    assert.deepEqual(read.ok && read.policy, { live: { turnAllowanceMs: 90_000 }, async: { turnAllowanceMs: 86_400_000 } });
    for (const bad of ["0", "-5", "1.5", "ten", "1e3", " 12x", "99999999999"]) {
      assert.equal(clockPolicyFromEnv({ GS_CLOCK_LIVE_TURN_SECONDS: bad }).ok, false, bad);
    }
    assert.equal(clockPolicyFromEnv({ GS_CLOCK_ASYNC_TURN_SECONDS: "" }).ok, true, "empty is unset");
  });

  test("a table freezes its own mode's slot when its clock starts", () => {
    assert.equal(newClockRecord(mintGameId(), "live", TEST_POLICY, T0).allowance_ms, 2 * MIN);
    assert.equal(newClockRecord(mintGameId(), "async", TEST_POLICY, T0).allowance_ms, 24 * 60 * MIN);
    assert.equal(newClockRecord(mintGameId(), "live", NO_APPROVED_CLOCK_POLICY, T0).allowance_ms, null);
  });
});

describe("Phase 3 lane A: the record's transitions (pure, integer ms)", () => {
  const gameId = mintGameId();
  const alice = factsAfter(0);
  const bob = factsAfter(1);

  const started = (): GameClockRecord => observeFacts(newClockRecord(gameId, "live", TEST_POLICY, T0), alice, T0, T0).record;

  test("the first observation starts the acting seat's turn; the same turn observed again changes nothing", () => {
    const record = started();
    assert.equal(record.turn?.seat, ALICE);
    assert.equal(record.turn?.started_at, T0);
    assert.equal(record.tally.turns, 1);
    assert.equal(isGameClockRecord(record), true);
    const again = observeFacts(record, alice, T0 + 5 * MIN, T0 + 5 * MIN);
    assert.equal(again.record, record, "a reload, a reconnect, a restart or a move inside the turn never resets it");
    assert.equal(elapsedOf(record, T0 + 5 * MIN), 5 * MIN);
  });

  test("a turn change hands the clock over: the old turn is summed up, the new seat starts from zero", () => {
    const record = started();
    const { record: next, ended } = observeFacts(record, bob, T0 + 3 * MIN, T0 + 3 * MIN);
    assert.equal(next.turn?.seat, BOB);
    assert.equal(elapsedOf(next, T0 + 3 * MIN), 0);
    assert.equal(elapsedOf(next, T0 + 4 * MIN), MIN);
    assert.deepEqual(ended, { seat: ALICE, key: alice.turnKey, active_ms: 3 * MIN, paused_ms: 0, allowance_ms: 2 * MIN, expired: true });
    assert.equal(next.revision, record.revision + 1);
  });

  test("pause freezes the remaining time; resume continues from it (paused time is never charged)", () => {
    const record = started();
    const paused = pauseClock(record, ALICE, T0 + 30_000);
    assert.ok(!("code" in paused));
    const p = paused.record;
    assert.equal(elapsedOf(p, T0 + 30_000), 30_000);
    assert.equal(elapsedOf(p, T0 + 50 * MIN), 30_000, "frozen while paused");
    const view = clockViewOf(p, { now: T0 + 50 * MIN, held: false });
    assert.equal(view.state, "paused");
    assert.equal(view.remainingMs, 2 * MIN - 30_000);
    const resumed = resumeClock(p, T0 + 50 * MIN);
    assert.ok(!("code" in resumed));
    const r = resumed.record;
    assert.equal(r.turn?.paused_ms, 50 * MIN - 30_000);
    assert.equal(elapsedOf(r, T0 + 50 * MIN), 30_000);
    assert.equal(elapsedOf(r, T0 + 50 * MIN + 10_000), 40_000, "counts on from what remained");
    /* Idempotent: a second pause or resume is answered as the clock stands, by identity. */
    assert.equal((pauseClock(p, BOB, T0 + 51 * MIN) as { record: GameClockRecord }).record, p);
    assert.equal((resumeClock(r, T0 + 51 * MIN) as { record: GameClockRecord }).record, r);
  });

  test("a turn that begins while paused starts paused, charged none of the earlier pause", () => {
    const p = (pauseClock(started(), ALICE, T0 + MIN) as { record: GameClockRecord }).record;
    const { record: next } = observeFacts(p, bob, T0 + 10 * MIN, T0 + 10 * MIN);
    assert.equal(next.pause?.since, T0 + 10 * MIN);
    assert.equal(elapsedOf(next, T0 + 30 * MIN), 0);
    const r = (resumeClock(next, T0 + 30 * MIN) as { record: GameClockRecord }).record;
    assert.equal(elapsedOf(r, T0 + 31 * MIN), MIN);
  });

  test("a turn of the same key is a NEW turn when another seat moved in between, even if the keeper never saw that turn", () => {
    const record = started(); // Alice's turn (the deal)
    const aliceAgain = factsAfter(2); // Alice bought, Bob bought: Alice is on turn again with the same key
    assert.equal(aliceAgain.turnKey, alice.turnKey, "one seat's turns in a round share a key");
    assert.equal(aliceAgain.lastForeignIndex > (record.turn?.from_index as number), true, "Bob moved after Alice's turn began");
    const { record: next } = observeFacts(record, aliceAgain, T0 + 5 * MIN, T0 + 5 * MIN);
    assert.notEqual(next, record, "never merged into the old turn");
    assert.equal(next.turn?.started_at, T0 + 5 * MIN);
    assert.equal(elapsedOf(next, T0 + 5 * MIN), 0);
  });

  test("an off-turn move by another seat that the server SAW leave the turn alone is vouched for: a reload keeps the turn", () => {
    const record = started();
    const answered: ClockFacts = { ...alice, watermark: alice.watermark + 1, lastForeignIndex: alice.watermark + 1 };
    assert.notEqual(observeFacts(record, answered, T0 + MIN, T0 + MIN).record.turn?.started_at, T0, "unvouched, a reload would take the answer for a hand-over");
    const vouched = vouchTurn(record, answered, T0 + MIN) as GameClockRecord;
    assert.equal(vouched.turn?.continued_to, alice.watermark + 1);
    assert.equal(observeFacts(vouched, answered, T0 + 5 * MIN, T0 + 5 * MIN).record, vouched, "the same turn, after any reload");
    assert.equal(vouchTurn(vouched, answered, T0 + 2 * MIN), null, "vouched once");
  });

  test("a move an undo took back is not another seat's move (the scan reads only what stands)", () => {
    const session = boardAfter(2); // deal, Alice a1, Bob b1: Alice on turn
    const handover = session.entries.filter((entry) => entry.actor === BOB && entry.derived !== true).pop() as { index: number; at?: number };
    const before = clockFactsOf({ state: session.state, entries: session.entries }, { ended: false, closed: false });
    for (const [n, seat] of [[2, ALICE], [3, BOB]] as const) {
      assert.equal(session.submit({ actor: seat, build: BUILD, msg: BUY as never, baseIndex: session.nextIndex - 1, submissionId: `buy-${n}` }).kind, "applied");
    }
    const moves = session.entries.filter((entry) => entry.derived !== true && entry.index > handover.index);
    for (const move of [...moves].reverse()) {
      const answer = session.submit({ actor: ALICE, build: BUILD, msg: { RevertTo: { index: move.index, player: ALICE, summary: "undo" } } as never, baseIndex: session.nextIndex - 1, submissionId: `undo-${move.index}`, host: ALICE, undoPolicy: { host_undo: "last-action" } });
      assert.equal(answer.kind, "applied", JSON.stringify(answer));
    }
    const after = clockFactsOf({ state: session.state, entries: session.entries }, { ended: false, closed: false });
    assert.equal(after.seat, ALICE);
    assert.equal(after.turnKey, before.turnKey);
    assert.equal(after.lastForeignIndex, before.lastForeignIndex, "Bob's undone purchase is not counted; the hand-over is still Bob's b1");
    assert.equal(after.handoverAt, before.handoverAt);
  });

  test("an undo that reaches back into an ended turn resumes it with the time it had used -- never a fresh allowance", () => {
    const session = boardAfter(1); // the deal, Alice's purchase: Bob on turn
    const aliceTurn = observeFacts(newClockRecord(gameId, "live", TEST_POLICY, T0), clockFactsOf({ state: boardAfter(0).state, entries: boardAfter(0).entries }, { ended: false, closed: false }), T0, T0).record;
    const bobFacts = clockFactsOf({ state: session.state, entries: session.entries }, { ended: false, closed: false });
    const bobTurn = observeFacts(aliceTurn, bobFacts, T0 + 90_000, T0 + 90_000).record;
    assert.deepEqual(bobTurn.history.map((past) => [past.seat, past.active_ms]), [[ALICE, 90_000]]);
    const buy = session.entries.filter((entry) => entry.actor === ALICE && entry.derived !== true).pop() as { index: number };
    const undone = session.submit({ actor: ALICE, build: BUILD, msg: { RevertTo: { index: buy.index, player: ALICE, summary: "undo" } } as never, baseIndex: session.nextIndex - 1, submissionId: "undo" });
    assert.equal(undone.kind, "applied", JSON.stringify(undone));
    const back = clockFactsOf({ state: session.state, entries: session.entries }, { ended: false, closed: false });
    assert.equal(back.seat, ALICE);
    assert.equal(back.undo?.target, buy.index, "the standing undo takes back from Alice's purchase on");
    assert.equal((bobTurn.turn?.from_index as number) >= buy.index, true, "Bob's turn began inside the undone range");
    const { record: resumed } = observeFacts(bobTurn, back, T0 + 100_000, T0 + 100_000);
    assert.equal(resumed.turn?.seat, ALICE);
    assert.equal(elapsedOf(resumed, T0 + 100_000), 90_000, "resumed with the 90 s it had used");
    assert.equal(resumed.history.length, 0);
    assert.equal(resumed.tally.turns, bobTurn.tally.turns, "a resumed turn is not a new turn");
  });

  test("expiry is a fact, noted once: the view says expired, the clock keeps counting, nothing else changes", () => {
    const record = started();
    assert.equal(msUntilExpiry(record, T0), 2 * MIN);
    assert.equal(noteExpiry(record, T0 + MIN), null, "not before its allowance");
    const noted = noteExpiry(record, T0 + 2 * MIN) as GameClockRecord;
    assert.equal(noted.turn?.expired_at, T0 + 2 * MIN);
    assert.equal(noted.tally.expiries, 1);
    assert.equal(noteExpiry(noted, T0 + 3 * MIN), null, "noted once");
    const view = clockViewOf(noted, { now: T0 + 3 * MIN, held: false });
    assert.equal(view.state, "expired");
    assert.equal(view.remainingMs, 0);
    assert.equal(view.elapsedMs, 3 * MIN, "overtime is counted, never acted on");
    assert.equal(view.seat, ALICE, "the same seat keeps the turn: nobody is forfeited or skipped");
  });

  test("no duration (the shipped default) counts up and never expires", () => {
    const record = observeFacts(newClockRecord(gameId, "async", NO_APPROVED_CLOCK_POLICY, T0), alice, T0, T0).record;
    assert.equal(msUntilExpiry(record, T0), null);
    assert.equal(noteExpiry(record, T0 + 365 * 24 * 60 * MIN), null);
    const view = clockViewOf(record, { now: T0 + 7 * MIN, held: false });
    assert.deepEqual([view.state, view.remainingMs, view.elapsedMs, view.allowanceMs, view.mode], ["running", null, 7 * MIN, null, "async"]);
  });

  test("GameEnd stops timing for good", () => {
    const record = started();
    const { record: stopped, ended } = observeFacts(record, factsAfter(0, { ended: true, closed: false }), T0 + MIN, T0 + MIN);
    assert.equal(stopped.stopped_at, T0 + MIN);
    assert.equal(ended?.active_ms, MIN);
    assert.equal(elapsedOf(stopped, T0 + 100 * MIN), MIN, "nothing counts after GameEnd");
    assert.equal(clockViewOf(stopped, { now: T0 + 100 * MIN, held: false }).state, "stopped");
    assert.equal(msUntilExpiry(stopped, T0 + 100 * MIN), null);
    assert.equal("code" in pauseClock(stopped, ALICE, T0 + 2 * MIN), true, "a stopped clock cannot be paused");
  });

  test("a held table's view says held (never shown live)", () => {
    assert.equal(clockViewOf(started(), { now: T0, held: true }).state, "held");
  });
});

describe("Phase 3 lane A: the stores", () => {
  test("memory and file stores: create, conditional replace on the revision, read back exactly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p3clock-"));
    try {
      for (const store of [createMemoryClockStore(), createFileClockStore(dir, { warn: () => undefined })]) {
        const gameId = mintGameId();
        const first = observeFacts(newClockRecord(gameId, "live", TEST_POLICY, T0), factsAfter(0), T0, T0).record;
        assert.equal((await store.save(first, 5)).kind, "definite", "a revision that is not there is refused");
        assert.equal((await store.save(first, null)).kind, "committed");
        assert.equal((await store.save(first, null)).kind, "definite", "create-if-absent only");
        assert.deepEqual(await store.load(gameId), first);
        const next = observeFacts(first, factsAfter(1), T0 + MIN, T0 + MIN).record;
        assert.equal((await store.save(next, first.revision - 1)).kind, "definite", "a stale writer is refused");
        assert.equal((await store.save(next, first.revision)).kind, "committed");
        assert.deepEqual(await store.load(gameId), next);
        assert.equal(await store.load(mintGameId()), null);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a damaged or newer-build clock file is unreadable -- reported, never overwritten", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p3clock-bad-"));
    try {
      const store = createFileClockStore(dir, { warn: () => undefined });
      const damaged = mintGameId();
      const newer = mintGameId();
      fs.mkdirSync(store.directory, { recursive: true });
      fs.writeFileSync(path.join(store.directory, `${damaged}.json`), "{not json");
      fs.writeFileSync(path.join(store.directory, `${newer}.json`), JSON.stringify({ format: "gs-game-clock", version: 2, game_id: newer }));
      await assert.rejects(store.load(damaged), ClockUnreadableError);
      await assert.rejects(store.load(newer), (error: unknown) => error instanceof ClockUnreadableError && error.newer);
      const record = newClockRecord(damaged, "live", TEST_POLICY, T0);
      assert.equal((await store.save(record, null)).kind, "definite");
      assert.equal(fs.readFileSync(path.join(store.directory, `${damaged}.json`), "utf8"), "{not json", "left exactly as found");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Phase 3 lane A: the keeper, on controlled time", () => {
  function keeperOn(store = createMemoryClockStore(), policy: ClockPolicy = TEST_POLICY) {
    const time = fakeTime();
    const ops = createMemoryOpsRecorder();
    const changes: string[] = [];
    let serving = true;
    const keeper = createClockKeeper({
      store,
      policy,
      now: time.now,
      ops,
      warn: () => undefined,
      onChange: (gameId) => changes.push(gameId),
      serving: () => serving,
      timers: time.timers,
    });
    return { keeper, time, ops, changes, store, stopServing: () => (serving = false) };
  }

  test("a load starts the acting seat's turn; a commit moves it; a restart (a fresh keeper) keeps the turn's start", async () => {
    const store = createMemoryClockStore();
    const { keeper, time } = keeperOn(store);
    const gameId = mintGameId();
    await keeper.load(gameId, { mode: "live", facts: null, held: false });
    assert.equal(keeper.viewOf(gameId, { mode: "live", held: false, dealt: false }), null, "nothing before the deal");
    keeper.observe(gameId, factsAfter(0), false, "live");
    await keeper.settled(gameId);
    assert.equal(keeper.recordOf(gameId)?.turn?.started_at, T0);
    await time.advance(30_000);
    keeper.observe(gameId, factsAfter(1), false, "live");
    await keeper.settled(gameId);
    const bobTurn = keeper.recordOf(gameId);
    assert.equal(bobTurn?.turn?.seat, BOB);
    assert.equal(bobTurn?.turn?.started_at, T0 + 30_000);
    await time.advance(45_000);
    /* A restart: a new keeper over the same store, the same board. */
    const again = keeperOn(store);
    await again.time.advance(75_000);
    await again.keeper.load(gameId, { mode: "live", facts: factsAfter(1), held: false });
    const view = again.keeper.viewOf(gameId, { mode: "live", held: false, dealt: true });
    assert.equal(view?.seat, BOB);
    assert.equal(view?.turnStartedAt, T0 + 30_000, "the restart did not reset the turn");
    assert.equal(view?.elapsedMs, 45_000);
  });

  test("expiry fires on time: noted, audited, re-broadcast -- and nothing else (no store but the clock's, no gameplay port)", async () => {
    const { keeper, time, ops, changes, store } = keeperOn();
    const gameId = mintGameId();
    await keeper.load(gameId, { mode: "live", facts: null, held: false });
    keeper.observe(gameId, factsAfter(0), false, "live"); // the deal's commit: the turn starts now (T0)
    await keeper.settled(gameId);
    const before = store.saves.length;
    await time.advance(2 * MIN - 1);
    assert.equal(ops.lines.filter((line) => line.event === "clock.expired").length, 0);
    await time.advance(5);
    await keeper.settled(gameId);
    assert.equal(ops.lines.filter((line) => line.event === "clock.expired").length, 1);
    assert.equal(keeper.viewOf(gameId, { mode: "live", held: false, dealt: true })?.state, "expired");
    assert.equal(store.saves.length, before + 1, "one note, in the clock's own store");
    assert.ok(changes.includes(gameId));
    assert.equal(ops.lines.some((line) => /forfeit|clemency|settle|decline/i.test(JSON.stringify(line))), false);
  });

  test("pause / resume are durable before they are acknowledged, and bound to the revision the tab saw", async () => {
    const { keeper, time, store } = keeperOn();
    const gameId = mintGameId();
    await keeper.load(gameId, { mode: "live", facts: null, held: false });
    keeper.observe(gameId, factsAfter(0), false, "live");
    await keeper.settled(gameId);
    const revision = keeper.recordOf(gameId)?.revision as number;
    assert.equal((await keeper.pause(gameId, ALICE, revision - 1)).ok, false, "a stale tab is refused");
    store.failSaves.push("definite");
    const failed = await keeper.pause(gameId, ALICE, revision);
    assert.equal(failed.ok, false, "a pause the store did not take is not acknowledged");
    assert.equal(keeper.recordOf(gameId)?.pause, null, "and not shown");
    await time.advance(1_000);
    const fresh = keeper.recordOf(gameId)?.revision as number;
    assert.deepEqual(await keeper.pause(gameId, ALICE, fresh), { ok: true });
    assert.notEqual((await store.load(gameId))?.pause, null, "durable");
    await time.advance(10 * MIN);
    assert.equal(keeper.viewOf(gameId, { mode: "live", held: false, dealt: true })?.state, "paused", "no expiry while paused");
    assert.deepEqual(await keeper.resume(gameId, ALICE, keeper.recordOf(gameId)?.revision as number), { ok: true });
  });

  test("an off-turn answer seen live is vouched for durably: a fresh keeper (a reload) keeps the turn's start", async () => {
    const store = createMemoryClockStore();
    const { keeper, time } = keeperOn(store);
    const gameId = mintGameId();
    await keeper.load(gameId, { mode: "live", facts: null, held: false });
    const dealt = factsAfter(0);
    keeper.observe(gameId, dealt, false, "live");
    await keeper.settled(gameId);
    await time.advance(40_000);
    const answered: ClockFacts = { ...dealt, watermark: dealt.watermark + 1, lastForeignIndex: dealt.watermark + 1, handoverAt: time.now() };
    keeper.observe(gameId, answered, false, "live");
    await keeper.settled(gameId);
    assert.equal((await store.load(gameId))?.turn?.continued_to, dealt.watermark + 1, "vouched, durably");
    const again = keeperOn(store);
    await again.time.advance(60_000);
    await again.keeper.load(gameId, { mode: "live", facts: answered, held: false });
    assert.equal(again.keeper.viewOf(gameId, { mode: "live", held: false, dealt: true })?.turnStartedAt, T0, "the answer was not taken for a hand-over");
  });

  test("a failing clock store costs the clock, never a throw: the keeper rereads and the restart evidence holds", async () => {
    const store = createMemoryClockStore();
    const { keeper, time } = keeperOn(store);
    const gameId = mintGameId();
    store.failSaves.push("uncertain-lost");
    await keeper.load(gameId, { mode: "live", facts: factsAfter(0), held: false });
    assert.equal(keeper.recordOf(gameId)?.turn?.seat, ALICE, "shown at once");
    assert.equal(await store.load(gameId), null, "the write was lost");
    await time.advance(2_000); // the retry rereads and writes again
    await keeper.settled(gameId);
    assert.equal((await store.load(gameId))?.turn?.seat, ALICE);
  });

  test("an unreadable stored clock: shown unavailable, never written, the game untouched", async () => {
    const store = createMemoryClockStore();
    const gameId = mintGameId();
    store.clocks.set(gameId, "unreadable");
    const { keeper } = keeperOn(store);
    await keeper.load(gameId, { mode: "async", facts: factsAfter(0), held: false });
    const view = keeper.viewOf(gameId, { mode: "async", held: false, dealt: true });
    assert.equal(view?.state, "unavailable");
    assert.equal(view?.mode, "async");
    assert.equal(store.clocks.get(gameId), "unreadable");
    assert.equal((await keeper.pause(gameId, ALICE, 1)).ok, false);
  });

  test("a game no longer served here: its timers do nothing and its entry is dropped", async () => {
    const { keeper, time, ops, stopServing } = keeperOn();
    const gameId = mintGameId();
    await keeper.load(gameId, { mode: "live", facts: factsAfter(0), held: false });
    stopServing();
    await time.advance(10 * MIN);
    assert.equal(ops.lines.filter((line) => line.event === "clock.expired").length, 0);
    assert.equal(keeper.size(), 0);
  });
});

describe("Phase 3 lane A: STRUCTURAL PROOF -- the clock reaches nothing of gameplay, escrow or settlement", () => {
  const sources = ["gameClock.ts", "clockKeeper.ts", path.join("..", "aws", "game", "dynamoClockStore.ts")].map((file) => {
    const compiled = path.join(__dirname, file);
    const source = compiled.replace(`${path.sep}dist${path.sep}server${path.sep}`, path.sep).replace(/\.js$/, ".ts");
    return { file, text: fs.readFileSync(fs.existsSync(source) ? source : compiled, "utf8") };
  });

  test("no import of escrow, settlement, money, the reducer's submit path or the actor", () => {
    for (const { file, text } of sources) {
      const imports = text.split("\n").filter((line) => /^import /.test(line));
      for (const line of imports) {
        assert.equal(/escrow|settle|money|juno|sandboxSession|roomSession"|gameActor|roomHost|recordStore|holdStore|lifecycle/i.test(line.replace(/import type .*$/, "")), false, `${file}: ${line}`);
      }
    }
  });

  test("no call that could make a move, decline an offer, forfeit or settle", () => {
    const forbidden = /\.submit\(|commitBatch|commitRecord|appendBatch|onGameplayClosed|onGameplayCommitted|Forfeit|Clemency|DeclineOffer|Reject[A-Z]\w*Offer|PassTurn|transferHost|persistHold/;
    for (const { file, text } of sources) {
      /* Code only: block and line comments removed (the comments say what the clock does NOT do, in those words). */
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      assert.equal(forbidden.test(code), false, `${file} names a gameplay, escrow or settlement action`);
    }
  });
});
