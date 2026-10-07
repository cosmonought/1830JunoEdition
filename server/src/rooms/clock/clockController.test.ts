// server/src/rooms/clock/clockController.test.ts
//
// PHASE 3 FINAL CLOCKS: the controller (`clockController.ts`) over a REAL engine session -- a legal phase-3 Operating
// board (`offerFixtures74.ts`) where PRR's president (p1) may offer to buy NYC's (p2) or C&O's (p3) trains -- on
// controlled time. What only real offers prove: the Live train-offer response timer freezes the proposer's clock
// exactly; an unanswered offer is CLOSED BY THE SERVER at 10:00 (the proposer's rescission, stamped at the exact
// moment) and the proposer resumes exactly what was left; a rejection or an expiry counts toward the two-decline
// limit per direction per Operating Round; the third proposal in one direction is refused with the owner's sentence
// while another direction stays open; an answer that arrives after the response time ended is refused (the offer
// is gone) rather than accepted late.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { operatingBoard, P1, P2, P3, NYC, CO, PRR } from "../../../../frontend/src/utils/offerFixtures74";
import { sandboxReplayProviders } from "../../../../frontend/src/gameEngine/replayProviders";
import type { SandboxLogMsg } from "../../../../frontend/src/gameEngine/gameSetup";
import { RoomSession, type ServerLogEntry } from "../../../../frontend/src/utils/roomSession";
import type { MapGridResponse } from "../../../../frontend/src/components/hexContractTypes";
import { CLOCK_REFUSAL, declinesReachedSentence } from "../../../../frontend/src/utils/clockProtocol";
import { createMemoryOpsRecorder } from "../../persistence/opsRecorder";
import type { RemedyPort } from "../../escrow/remedyPipeline";
import type { ChainIntentRecord } from "../../escrow/chainIntents";
import type { GameActor, Tx } from "../gameActor";
import { createClockController, rescindExpiredOffer, type GateResult } from "./clockController";
import { createMemoryClockStore } from "./clockStore";
import { fakeTime } from "./clockTestSupport";
import { LIVE_ACTION_MS, LIVE_CURE_MS, LIVE_TRADE_MS, type GameClockRecord } from "./clockRecord";

const SEC = 1_000;
const MIN = 60 * SEC;
const T0 = 1_780_000_000_000;
const GAME = "g_00000000000000000000000020";
const GRID = { game_id: 1, tiles: [] } as unknown as MapGridResponse;

const proposeTrain = (seller: number, model: string, price: string) => ({
  ProposeTrainPurchase: { game_id: 1, seller_protocol_id: seller, seller_ticker: "x", seller_president: null, buyer_protocol_id: PRR, buyer_ticker: "PRR", model_type: model, price },
});
const answerTrain = (seller: number, accept: boolean) => ({ AnswerTrainPurchase: { game_id: 1, seller_protocol_id: seller, accept } });

function harness(options: { money?: boolean; remedy?: RemedyPort; loadFails?: { n: number }; held?: { on: boolean }; frozen?: { on: boolean }; closeFails?: { n: number } } = {}) {
  const time = fakeTime(T0);
  let stamp: number | null = null;
  const stampAt = <T>(at: number, fn: () => T): T => {
    const prior = stamp;
    stamp = at;
    try {
      return fn();
    } finally {
      stamp = prior;
    }
  };
  let minted = 0;
  const room = new RoomSession({
    providers: { ...sandboxReplayProviders(), initialGrid: GRID },
    seed: { state: operatingBoard(), waterfall: null },
    build: "b",
    mintId: () => `m${(minted += 1)}`,
    now: () => stamp ?? time.now(),
  });
  const game = {
    gameId: GAME,
    get view() {
      return { entries: room.entries, record: { variants: { mode: "live" }, money: options.money === true ? { mode: "live" } : null } };
    },
  } as unknown as GameActor;
  const tx = { session: room } as unknown as Tx;
  const ops = createMemoryOpsRecorder();
  const store = createMemoryClockStore();
  const conduct: string[] = [];
  const loading = {
    load: async (gameId: string) => {
      if (options.loadFails !== undefined && options.loadFails.n > 0) {
        options.loadFails.n -= 1;
        throw new Error("the store did not answer");
      }
      return store.load(gameId);
    },
    save: (record: Parameters<typeof store.save>[0], expected: number | null) => store.save(record, expected),
  };
  let chain: Promise<unknown> = Promise.resolve();
  /* The game's serialization: every task (a submit, a timer, an op) runs alone, in order. */
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };
  const clock = createClockController({
    store: loading,
    authority: "auth-1",
    conduct: (input) => conduct.push(input.event.kind),
    ...(options.held !== undefined ? { held: () => (options.held as { on: boolean }).on } : {}),
    ...(options.frozen !== undefined ? { frozen: () => (options.frozen as { on: boolean }).on } : {}),
    now: time.now,
    timers: time.timers,
    ops,
    warn: () => undefined,
    runOn: (_gameId, _label, task) => serial(() => task(game, tx)).then(() => true),
    onChange: () => undefined,
    serving: () => true,
    ...(options.remedy !== undefined ? { remedy: () => options.remedy as RemedyPort } : {}),
    closeOffer: async (_game, _tx, input) => {
      if (options.closeFails !== undefined && options.closeFails.n > 0) {
        options.closeFails.n -= 1;
        return { ok: false, why: "the expiry could not be committed", kind: "store" };
      }
      const closed = rescindExpiredOffer(room, { proposer: input.proposer, at: input.at, build: "b", host: P1, hostUndo: "last-action" }, stampAt);
      if (!closed.ok) return closed;
      return { ok: true, first: closed.batch[0].index, last: closed.batch[closed.batch.length - 1].index, before: closed.before, after: closed.after };
    },
  });

  /** A submit exactly as `gameServer.submitOnActor` runs it: gate, speculate stamped at the gate's time, fold. */
  const submit = (actor: string, msg: object) =>
    serial(async () => {
      const gate = await clock.gateSubmit(game, tx, { actor, msg });
      if (!gate.ok) return gate;
      const start = room.entries.length;
      const answer = stampAt(gate.now, () => room.submit({ actor, build: "b", host: P1, msg: msg as SandboxLogMsg, baseIndex: room.nextIndex - 1 }));
      if (answer.kind !== "applied") return { ok: false as const, code: answer.kind, reason: (answer as { reason?: string }).reason ?? "" };
      const batch = room.entries.slice(start);
      await clock.afterCommit(game, { gate: gate as GateResult, actor, batch, board: room.state });
      return { ok: true as const, at: batch[0]?.at };
    });

  const deal = () =>
    serial(async () => {
      if (options.money === true) assert.equal((await clock.createMoneyPolicy(GAME, "live", null)).ok, true);
      const batch: ServerLogEntry[] = [{ index: 0, id: "deal", actor: P1, payload: "{}", at: T0 } as ServerLogEntry];
      await clock.afterCommit(game, { gate: { ok: true, now: T0, before: null, cls: "deal", revertTarget: null }, actor: P1, batch, board: room.state });
    });

  const record = () => {
    const r = clock.recordOf(GAME);
    assert.ok(r !== null);
    return r;
  };
  const remaining = () => {
    const ob = record().obligation;
    assert.ok(ob?.timer);
    return ob.timer.since === null ? ob.timer.remaining_ms : ob.timer.remaining_ms - (time.now() - ob.timer.since);
  };
  return { time, room, clock, ops, store, submit, deal, record, remaining, serial, conduct, game, tx };
}

describe("Live train offers through the controller (real engine offers)", () => {
  test("a valid offer freezes the proposer exactly and gives the recipient a distinct 10:00; unanswered, the SERVER closes it at 10:00 and the proposer resumes exactly", async () => {
    const h = harness();
    await h.deal();
    assert.deepEqual([h.record().obligation?.seat, h.remaining()], [P1, LIVE_ACTION_MS]);
    await h.time.advance(4 * MIN + 30 * SEC);
    const proposed = await h.submit(P1, proposeTrain(NYC, "2", "50"));
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    const r = h.record();
    assert.deepEqual([r.obligation?.seat, r.obligation?.trade?.proposer, h.remaining()], [P2, P1, LIVE_TRADE_MS], "the recipient's distinct response timer");
    assert.deepEqual(r.parked, [{ seat: P1, offer_key: r.parked[0].offer_key, remaining_ms: 15 * MIN + 30 * SEC }], "the proposer's 15:30 frozen exactly");
    const view = h.clock.viewOf(GAME);
    assert.equal(view?.state, "trade");
    assert.deepEqual([view?.trade?.proposer, view?.trade?.recipient, view?.trade?.respond.remainingMs, view?.trade?.proposerRemainingMs], [P1, P2, LIVE_TRADE_MS, 15 * MIN + 30 * SEC]);
    await h.time.advance(LIVE_TRADE_MS);
    await h.serial(async () => undefined);
    const after = h.record();
    assert.equal(h.room.state.train_purchase_offer ?? null, null, "the offer was closed in the log");
    const rescind = h.room.entries.find((e) => e.payload.includes("RescindTrainPurchase"));
    assert.ok(rescind, "the server's own rescission is in the log");
    assert.equal(rescind.at, T0 + 4 * MIN + 30 * SEC + LIVE_TRADE_MS, "stamped at the exact moment the response time ended");
    assert.equal(rescind.actor, P1, "as the proposer's rescission");
    assert.deepEqual([after.obligation?.seat, h.remaining()], [P1, 15 * MIN + 30 * SEC], "the proposer resumes exactly what was left");
    assert.deepEqual(after.strikes, {}, "an expiry is no strike");
    assert.equal(after.phase, "active", "an expiry is never an overdue");
    assert.equal(after.declines.counts[`${P1}>${P2}`], 1, "an expiry counts as a decline");
    assert.ok(after.undo_floor >= rescind.index, "no undo may resurrect the expired offer");
    assert.ok(h.ops.lines.some((line) => line.event === "clock.trade-end"));
  });

  test("an answer that arrives after the response time ended is refused (the offer is gone), never accepted late", async () => {
    const h = harness();
    await h.deal();
    await h.submit(P1, proposeTrain(NYC, "2", "50"));
    await h.time.advance(LIVE_TRADE_MS - 5 * SEC);
    h.time.jump(5 * SEC + 1); // the expiry timer did not get to run before the answer arrived (a few seconds: no stall)
    const late = await h.submit(P2, answerTrain(NYC, true));
    assert.equal(late.ok, false);
    assert.equal((late as { code: string }).code, CLOCK_REFUSAL.stale);
    assert.equal(h.room.state.train_purchase_offer ?? null, null);
    assert.deepEqual(h.record().obligation?.seat, P1);
  });

  test("two declines (a rejection, an expiry) per direction per Operating Round; the third proposal is refused with the owner's sentence; another direction stays open", async () => {
    const h = harness();
    await h.deal();
    await h.submit(P1, proposeTrain(NYC, "2", "50"));
    await h.time.advance(MIN);
    const rejected = await h.submit(P2, answerTrain(NYC, false));
    assert.equal(rejected.ok, true, JSON.stringify(rejected));
    assert.deepEqual([h.record().obligation?.seat, h.remaining()], [P1, LIVE_ACTION_MS], "the rejection completed p2's decision; p1 owes the next one");
    assert.equal(h.record().declines.counts[`${P1}>${P2}`], 1);
    await h.submit(P1, proposeTrain(NYC, "2", "60"));
    await h.time.advance(LIVE_TRADE_MS);
    await h.serial(async () => undefined);
    assert.equal(h.record().declines.counts[`${P1}>${P2}`], 2, "the expiry is the second decline");
    const third = await h.submit(P1, proposeTrain(NYC, "2", "70"));
    assert.equal(third.ok, false);
    assert.equal((third as { code: string }).code, CLOCK_REFUSAL.declines);
    assert.equal((third as { reason: string }).reason, declinesReachedSentence(P2));
    const other = await h.submit(P1, proposeTrain(CO, "3", "100"));
    assert.equal(other.ok, true, `another direction is open: ${JSON.stringify(other)}`);
    assert.equal(h.record().obligation?.seat, P3);
  });

  test("an accepted offer refreshes the proposer's allowance (a completed trade is progress); a rescission is charged the time its offer stood", async () => {
    const h = harness();
    await h.deal();
    await h.time.advance(6 * MIN);
    await h.submit(P1, proposeTrain(NYC, "2", "50"));
    await h.time.advance(2 * MIN);
    await h.submit(P1, { RescindTrainPurchase: { game_id: 1, seller_protocol_id: NYC } });
    assert.deepEqual([h.record().obligation?.seat, h.remaining()], [P1, 12 * MIN], "the proposer's own rescission never stops its clock: the 2:00 the offer stood is charged");
    assert.equal(h.record().declines.counts[`${P1}>${P2}`] ?? 0, 0, "a rescission is not a decline");
    await h.submit(P1, proposeTrain(NYC, "2", "50"));
    await h.time.advance(3 * MIN);
    const accepted = await h.submit(P2, answerTrain(NYC, true));
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.deepEqual([h.record().obligation?.seat, h.remaining()], [P1, LIVE_ACTION_MS]);
  });

  test("a stall inside one process (no heartbeat for over a minute) is a continuity break: SYSTEM PAUSE as of the last proof, never an overdue from it", async () => {
    const h = harness();
    await h.deal();
    await h.time.advance(5 * MIN);
    const proven = h.record().trusted_at;
    assert.ok(proven >= T0 + 5 * MIN - 10 * SEC, "heartbeats keep the proof fresh while the clock runs");
    h.time.jump(25 * MIN); // the process was frozen: no timer, no heartbeat ran
    const refused = await h.submit(P1, proposeTrain(NYC, "2", "50"));
    assert.equal(refused.ok, false);
    assert.equal((refused as { code: string }).code, CLOCK_REFUSAL.systemPaused);
    const r = h.record();
    assert.deepEqual([r.phase, r.strikes, r.system?.preserved_at], ["active", {}, proven]);
    assert.equal(r.obligation?.timer?.remaining_ms, LIVE_ACTION_MS - (proven - T0), "the time since the last proof is never charged");
    assert.ok(h.ops.lines.some((line) => line.event === "clock.continuity-break" && line.cause === "stall"));
  });

  test("an offer the engine refuses never freezes the proposer's clock", async () => {
    const h = harness();
    await h.deal();
    await h.time.advance(3 * MIN);
    const refused = await h.submit(P1, proposeTrain(NYC, "9", "50"));
    assert.equal(refused.ok, false, "NYC owns no 9-train");
    assert.deepEqual([h.record().obligation?.seat, h.record().obligation?.trade, h.remaining()], [P1, null, LIVE_ACTION_MS - 3 * MIN]);
    assert.deepEqual(h.record().parked, []);
  });

  test("a stale authority stops deciding: another server's write is found at the next write; a money table's moves are then refused", async () => {
    const h = harness({ money: true });
    await h.deal();
    const mine = h.record();
    h.store.clocks.set(GAME, { ...mine, authority: "auth-other", revision: mine.revision + 7 });
    const first = await h.submit(P1, proposeTrain(NYC, "2", "50"));
    assert.equal(first.ok, true, "decided on the record in hand; its write is refused by the store's CAS");
    const next = await h.submit(P2, answerTrain(NYC, false));
    assert.equal(next.ok, false);
    assert.equal((next as { code: string }).code, CLOCK_REFUSAL.unavailable, "this process no longer decides the table");
    assert.ok(h.ops.lines.some((line) => line.event === "clock.lost"));
    const stored = h.store.clocks.get(GAME) as { authority: string };
    assert.equal(stored.authority, "auth-other", "the other authority's record is never overwritten");
  });

  test("the remedy gate: an open unanimous annulment supersedes a sealed remedy (nothing relayed); otherwise ok", async () => {
    let annulOpen = true;
    const port = { configured: true, annulOpen: async () => annulOpen, attest: async () => ({ status: "sealed", detail: null, attested: false }), progress: async () => "none", fence: () => undefined } as unknown as RemedyPort;
    const h = harness({ money: true, remedy: port });
    await h.deal();
    await h.time.advance(LIVE_ACTION_MS + LIVE_CURE_MS);
    await h.clock.idle();
    const r = h.record();
    assert.equal(r.remedy?.kind, 1);
    const intent = { op: { kind: "remedy", remedy: 1, overdue_epoch: String(r.remedy?.epoch), log_len: String(r.remedy?.log_len), strike: r.remedy?.strike } } as unknown as ChainIntentRecord;
    const waiting = await h.clock.remedyGate(GAME, intent);
    assert.equal(waiting.kind, "wait");
    assert.match((waiting as { why: string }).why, /annulment/);
    annulOpen = false;
    assert.equal((await h.clock.remedyGate(GAME, intent)).kind, "ok");
    const other = { op: { ...intent.op, overdue_epoch: "99" } } as unknown as ChainIntentRecord;
    assert.equal((await h.clock.remedyGate(GAME, other)).kind, "wait", "an intent that is not the sealed decision never passes");
  });

  test("the recipient's response timer is never an overdue: no strike, no interruption, no remedy", async () => {
    const h = harness();
    await h.deal();
    await h.submit(P1, proposeTrain(NYC, "2", "50"));
    await h.time.advance(LIVE_TRADE_MS + 5 * MIN);
    await h.serial(async () => undefined);
    const r = h.record();
    assert.deepEqual([r.phase, r.overdue, r.strikes, r.remedy], ["active", null, {}, null]);
  });
});

describe("Controller review fixes: reads, durability, holds, retries", () => {
  test("a store that does not answer: no move is judged without the clock, and nothing is fabricated in its place", async () => {
    const loadFails = { n: 0 };
    const h = harness({ loadFails });
    await h.deal();
    h.clock.drop(GAME); // the next decision must read the store again
    loadFails.n = 1;
    const refused = await h.submit(P1, proposeTrain(NYC, "2", "50"));
    assert.equal(refused.ok, false);
    assert.equal((refused as { code: string }).code, CLOCK_REFUSAL.unavailable);
    assert.equal(h.room.entries.length, 0, "nothing was played");
    const stored = h.store.clocks.get(GAME) as { revision: number };
    const again = await h.submit(P1, proposeTrain(NYC, "2", "50"));
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.ok((h.store.clocks.get(GAME) as { revision: number }).revision > stored.revision, "the stored record went on (never replaced by a fresh one)");
  });

  test("evidence is reported only once its record is DURABLE: a write that did not land reports nothing; the next one reports it all", async () => {
    const h = harness();
    await h.deal();
    const before = h.conduct.length;
    h.store.failSaves.push("definite");
    await h.submit(P1, proposeTrain(NYC, "2", "50"));
    assert.equal(h.conduct.length, before, "the trade's evidence waits for its record");
    assert.equal(h.record().obligation?.trade?.proposer, P1, "the decided record stands in memory (written on the next attempt)");
    await h.time.advance(30 * SEC); // a heartbeat writes it
    assert.ok(h.conduct.slice(before).includes("trade-begin"), "reported once durable");
    assert.equal((h.store.clocks.get(GAME) as { obligation: { trade: unknown } }).obligation.trade !== null, true);
  });

  test("a HELD table's clock does not run; when the hold lifts, the held time is a continuity break (SYSTEM PAUSE), never an overdue", async () => {
    const held = { on: false };
    const h = harness({ held });
    await h.deal();
    await h.time.advance(5 * MIN);
    held.on = true;
    await h.time.advance(40 * MIN);
    await h.clock.idle();
    assert.deepEqual([h.record().phase, h.record().strikes], ["active", {}], "no overdue while nobody could move");
    held.on = false;
    const refused = await h.submit(P1, proposeTrain(NYC, "2", "50"));
    assert.equal((refused as { code: string }).code, CLOCK_REFUSAL.systemPaused);
    assert.ok(h.record().obligation?.timer && h.record().obligation!.timer!.remaining_ms >= 14 * MIN, "the held time is never charged");
  });

  test("an expiry whose commit did not land is retried (the clock is not re-derived from a board that did not change)", async () => {
    const closeFails = { n: 1 };
    const h = harness({ closeFails });
    await h.deal();
    await h.submit(P1, proposeTrain(NYC, "2", "50"));
    await h.time.advance(LIVE_TRADE_MS);
    await h.clock.idle();
    assert.equal(h.record().obligation?.trade?.proposer, P1, "still the standing offer's response time (ran out, not re-derived)");
    await h.time.advance(5 * SEC);
    await h.clock.idle();
    assert.equal(h.room.state.train_purchase_offer ?? null, null, "the retry closed it");
    assert.deepEqual([h.record().obligation?.seat, h.record().declines.counts[`${P1}>${P2}`]], [P1, 1]);
  });
});

describe("Controller review fixes (second pass): outages and authority changes", () => {
  test("a clock-store write outage: no move is taken on an unstored clock, and once it outlasts the limit the table is SYSTEM-PAUSED -- never an overdue from it", async () => {
    const h = harness();
    await h.deal();
    await h.time.advance(2 * MIN);
    for (let i = 0; i < 400; i += 1) h.store.failSaves.push("definite");
    await h.time.advance(25 * MIN);
    await h.clock.idle();
    const r = h.record();
    assert.deepEqual([r.phase, r.strikes, r.system !== null], ["active", {}, true], "the outage became a system pause, not a strike");
    assert.ok((r.obligation?.timer?.remaining_ms ?? 0) >= 17 * MIN, "the outage was never charged");
    h.store.failSaves.length = 0;
    const refused = await h.submit(P1, proposeTrain(NYC, "2", "50"));
    assert.equal((refused as { code: string }).code, CLOCK_REFUSAL.systemPaused);
  });

  test("an AWS takeover (another pool / epoch / task) is a new authority: the Live table is SYSTEM-PAUSED before anyone moves", async () => {
    const h = harness();
    await h.deal();
    await h.time.advance(3 * MIN);
    await h.clock.idle();
    const stored = h.store.clocks.get(GAME) as GameClockRecord;
    h.store.clocks.set(GAME, { ...stored, authority: "aws:7:pool-a:3:task-1" });
    h.clock.drop(GAME);
    const refused = await h.submit(P1, proposeTrain(NYC, "2", "50"));
    assert.equal((refused as { code: string }).code, CLOCK_REFUSAL.systemPaused);
    assert.ok(h.ops.lines.some((line) => line.event === "clock.continuity-break" && String(line.prior_authority).startsWith("aws:7:pool-a")));
  });

  test("the server's expiry closes only THE offer whose time ran out", () => {
    const h = harness();
    const offer = h.room.state.train_purchase_offer ?? null;
    assert.equal(offer, null);
    const closed = rescindExpiredOffer(h.room, { proposer: P1, at: T0, offerKey: "train:other", build: "b", host: P1, hostUndo: "last-action" });
    assert.equal(closed.ok, false);
  });
});

describe("Controller review fixes (third pass)", () => {
  test("an Async table reloaded by this same process is proven continuous from the reload: no outage credit later", async () => {
    const h = harness();
    assert.equal((await h.clock.createPolicy(GAME, { deadline: "async-pace", paceSecs: 43_200, money: false })).ok, true);
    await h.deal();
    assert.equal(h.record().policy.class, "async-pace");
    await h.time.advance(MIN);
    await h.clock.idle();
    h.clock.drop(GAME); // evicted: no heartbeat runs while it is unloaded
    h.time.jump(6 * 60 * MIN);
    /* A refused op reloads it (an Async table cannot pause). */
    const refused = await h.serial(() => h.clock.op(h.game, h.tx, { type: "clock-pause", seat: P1, action: "request", kind: "pause", id: null }));
    assert.equal(refused.ok, false, "an Async table does not pause");
    /* Then the load task the host runs for every (re)loaded actor: its stall check measures from the reload. */
    h.time.jump(30 * SEC);
    h.clock.loaded(GAME);
    await h.clock.idle();
    await h.time.advance(40 * MIN);
    await h.clock.idle();
    const r = h.record();
    assert.ok(!r.evidence.window.some((e) => e.kind === "outage-credited"), "the unloaded time was real: never credited");
    const timer = r.obligation?.timer;
    assert.ok(timer !== null && timer !== undefined);
    const left = timer.since === null ? timer.remaining_ms : timer.remaining_ms - (h.time.now() - timer.since);
    assert.ok(left <= 43_200_000 - 6 * 60 * MIN, `the 6 hours unloaded were charged (${left} ms left)`);
  });
});

describe("Controller review fixes (fourth pass)", () => {
  test("a FROZEN table (its log at the cap) runs no timer, but its votes still work", async () => {
    const frozen = { on: false };
    const h = harness({ frozen });
    await h.deal();
    await h.time.advance(LIVE_ACTION_MS);
    await h.clock.idle();
    assert.equal(h.record().phase, "overdue");
    frozen.on = true;
    await h.time.advance(LIVE_CURE_MS + MIN);
    await h.clock.idle();
    assert.equal(h.record().phase, "overdue", "no finality while nobody can make the owed move");
    const voted = await h.serial(() => h.clock.op(h.game, h.tx, { type: "clock-propose", seat: P2, kind: "foreclose", approval: null, verifiedFor: null, stale: [] }));
    assert.equal(voted.ok, true, JSON.stringify(voted));
  });

  test("an Async overdue keeps nothing running: no residency, no heartbeat writes", async () => {
    const h = harness();
    assert.equal((await h.clock.createPolicy(GAME, { deadline: "async-pace", paceSecs: 43_200, money: false })).ok, true);
    await h.deal();
    await h.time.advance(43_200_000);
    await h.clock.idle();
    assert.equal(h.record().phase, "overdue");
    const writes = h.store.saves.length;
    await h.time.advance(60 * MIN);
    await h.clock.idle();
    assert.equal(h.store.saves.length, writes, "no heartbeat writes while overdue");
  });
});

describe("Controller review fixes (fifth pass): every offer kind is bounded by its direction's declines", () => {
  test("after two declines, the board's own offer (any kind) is refused before it is committed -- the answerer named by the board", async () => {
    const h = harness();
    await h.deal();
    await h.submit(P1, proposeTrain(NYC, "2", "50"));
    const standing = structuredClone(h.room.state);
    assert.equal(h.clock.offerBlocked(h.game, { actor: P1, board: standing }), null, "no declines yet");
    await h.submit(P2, answerTrain(NYC, false));
    await h.submit(P1, proposeTrain(NYC, "2", "60"));
    await h.time.advance(LIVE_TRADE_MS);
    await h.serial(async () => undefined);
    const blocked = h.clock.offerBlocked(h.game, { actor: P1, board: standing });
    assert.equal(blocked?.code, CLOCK_REFUSAL.declines);
    assert.equal(blocked?.reason, declinesReachedSentence(P2));
    assert.equal(h.clock.offerBlocked(h.game, { actor: P2, board: standing }), null, "only the proposer named by the board is judged");
  });
});
