// server/src/rooms/clock/clockController.test.ts
//
// PHASE 3 FINAL CLOCKS: the controller (`clockController.ts`) over a REAL engine session -- a legal phase-3 Operating
// board (`offerFixtures74.ts`) where PRR's president (p1) may offer to buy NYC's (p2) or C&O's (p3) trains -- on
// controlled time. What only real offers prove: the Live train-offer response timer freezes the proposer's clock
// exactly; an unanswered offer is CLOSED BY THE SERVER at 10:00 (the proposer's rescission, stamped at the exact
// moment) and the proposer resumes exactly what was left; a rejection or an expiry counts toward the two-decline
// limit per direction per round instance (operating sub-round); the third proposal in one direction is refused with the owner's sentence
// while another direction stays open; an answer that arrives after the response time ended is refused (the offer
// is gone) rather than accepted late.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { operatingBoard, P1, P2, P3, NYC, CO, PRR, DH } from "../../../../frontend/src/utils/offerFixtures74";
import { sandboxReplayProviders } from "../../../../frontend/src/gameEngine/replayProviders";
import type { SandboxLogMsg } from "../../../../frontend/src/gameEngine/gameSetup";
import { RoomSession, type ServerLogEntry } from "../../../../frontend/src/utils/roomSession";
import type { MapGridResponse } from "../../../../frontend/src/components/hexContractTypes";
import { CLOCK_REFUSAL, declinesReachedSentence } from "../../../../frontend/src/utils/clockProtocol";
import { createMemoryOpsRecorder } from "../../persistence/opsRecorder";
import { remedyTimes, sealedRemedyProblem, type RemedyPort } from "../../escrow/remedyPipeline";
import type { ChainIntentRecord } from "../../escrow/chainIntents";
import type { GameActor, Tx } from "../gameActor";
import { createClockController, rescindExpiredOffer, type GateResult } from "./clockController";
import { createMemoryClockStore } from "./clockStore";
import { fakeTime } from "./clockTestSupport";
import { LIVE_ACTION_MS, LIVE_CURE_MS, LIVE_FREEZE_BUDGET_MS, LIVE_TRADE_MS, type GameClockRecord } from "./clockRecord";
import { logHash } from "../../../../frontend/src/gameEngine/logHash";

const SEC = 1_000;
const MIN = 60 * SEC;
const T0 = 1_780_000_000_000;
const GAME = "g_00000000000000000000000020";
const GRID = { game_id: 1, tiles: [] } as unknown as MapGridResponse;

const proposeTrain = (seller: number, model: string, price: string) => ({
  ProposeTrainPurchase: { game_id: 1, seller_protocol_id: seller, seller_ticker: "x", seller_president: null, buyer_protocol_id: PRR, buyer_ticker: "PRR", model_type: model, price },
});
const answerTrain = (seller: number, accept: boolean) => ({ AnswerTrainPurchase: { game_id: 1, seller_protocol_id: seller, accept } });

function harness(options: { money?: boolean; remedy?: RemedyPort; loadFails?: { n: number }; held?: { on: boolean }; closeFails?: { n: number }; pins?: boolean[] } = {}) {
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
    now: time.now,
    timers: time.timers,
    ops,
    warn: () => undefined,
    runOn: (_gameId, _label, task) => serial(() => task(game, tx)).then(() => true),
    onChange: () => undefined,
    serving: () => true,
    ...(options.pins !== undefined ? { pin: (_gameId: string, on: boolean) => void (options.pins as boolean[]).push(on) } : {}),
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
    assert.deepEqual(r.parked, [{ seat: P1, offer_key: r.parked[0].offer_key, remaining_ms: 15 * MIN + 30 * SEC, key: r.parked[0].key, freeze_ms: LIVE_FREEZE_BUDGET_MS }], "the proposer's 15:30 frozen exactly, with its episode's whole 10:00 freeze budget");
    assert.match(String(r.parked[0].key), /^turn:OperatingRound\|/, "with the required decision it was owing");
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
    assert.deepEqual([after.obligation?.seat, h.remaining(), after.obligation?.freeze_ms], [P1, 15 * MIN + 30 * SEC, 0], "the proposer resumes exactly what was left; the 10:00 wait used its whole freeze budget");
    assert.deepEqual(after.strikes, {}, "an expiry is no strike");
    assert.equal(after.phase, "active", "an expiry is never an overdue");
    assert.equal(after.declines.counts[`${P1}>${P2}`], 1, "an expiry counts as a decline");
    assert.ok(after.undo_floor >= rescind.index, "no undo may resurrect the expired offer");
    assert.ok(h.ops.lines.some((line) => line.event === "clock.trade-end"));
  });

  test("FREEZE BUDGET (owner ruling, 2026-10-07): an unanswered 10:00 offer uses the episode's whole budget; a later offer is still taken, P1's own clock runs while it waits, and when it runs out first the SERVER closes the offer (a real rescission at that moment, fenced, no decline) and P1 -- never the answerer -- is overdue; a reload never renews the budget", async () => {
    const h = harness();
    await h.deal();
    assert.equal(h.record().obligation?.freeze_ms, LIVE_FREEZE_BUDGET_MS);
    assert.equal((await h.submit(P1, proposeTrain(NYC, "2", "50"))).ok, true);
    await h.time.advance(LIVE_TRADE_MS);
    await h.clock.idle();
    assert.deepEqual([h.record().obligation?.seat, h.remaining(), h.record().obligation?.freeze_ms], [P1, LIVE_ACTION_MS, 0], "the unanswered 10:00 was frozen -- and used the whole budget");
    /* A reload of the table's clock (dropped, read back from the store) renews nothing. */
    h.clock.drop(GAME);
    h.clock.loaded(GAME);
    await h.clock.idle();
    assert.equal(h.record().obligation?.freeze_ms, 0);
    await h.time.advance(18 * MIN); // P1 has 2:00
    await h.clock.idle();
    const offeredAt = h.time.now();
    const proposed = await h.submit(P1, proposeTrain(CO, "3", "100"));
    assert.equal(proposed.ok, true, `an exhausted budget never refuses an offer: ${JSON.stringify(proposed)}`);
    assert.deepEqual([h.clock.viewOf(GAME)?.trade?.proposerFreezeMs, h.clock.viewOf(GAME)?.trade?.proposerRemainingMs], [0, 2 * MIN]);
    await h.time.advance(2 * MIN);
    await h.clock.idle();
    const r = h.record();
    assert.equal(h.room.state.train_purchase_offer ?? null, null, "the offer was closed in the log");
    const rescind = h.room.entries.filter((e) => e.payload.includes("RescindTrainPurchase")).pop();
    assert.ok(rescind !== undefined);
    assert.deepEqual([rescind.at, rescind.actor], [offeredAt + 2 * MIN, P1], "the proposer's rescission, stamped when its clock ran out");
    assert.deepEqual([r.phase, r.overdue?.seat, r.overdue?.at, r.strikes[P1], r.strikes[P3] ?? 0], ["overdue", P1, offeredAt + 2 * MIN, 1, 0], "P1 is overdue under the ordinary Live rules; the answerer, who still had response time, is never struck");
    assert.equal(r.declines.counts[`${P1}>${P3}`] ?? 0, 0, "a close at the proposer's deadline is no decline");
    assert.ok(r.undo_floor >= rescind.index, "fenced: no undo resurrects the closed offer");
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

  test("two declines (a rejection, an expiry) per direction per round instance (this operating sub-round); the third proposal is refused with the owner's sentence; another direction stays open", async () => {
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

  test("an ACCEPTED real train purchase does not refresh the proposer still owing its turn (owner, 2026-10-07); a rescission, like every resolution, draws on the episode's freeze budget", async () => {
    const h = harness();
    await h.deal();
    await h.time.advance(6 * MIN);
    await h.submit(P1, proposeTrain(NYC, "2", "50"));
    await h.time.advance(2 * MIN);
    await h.submit(P1, { RescindTrainPurchase: { game_id: 1, seller_protocol_id: NYC } });
    assert.deepEqual([h.record().obligation?.seat, h.remaining(), h.record().obligation?.freeze_ms], [P1, 14 * MIN, 8 * MIN], "the 2:00 the offer stood came from the freeze budget, never replenished by the withdrawal");
    assert.equal(h.record().declines.counts[`${P1}>${P2}`] ?? 0, 0, "a rescission is not a decline");
    await h.submit(P1, proposeTrain(NYC, "2", "50"));
    await h.time.advance(3 * MIN);
    const accepted = await h.submit(P2, answerTrain(NYC, true));
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.deepEqual([h.record().obligation?.seat, h.remaining(), h.record().obligation?.freeze_ms], [P1, 14 * MIN, 5 * MIN], "the 14:00 P1 had when it proposed: the trade happened, the turn did not end; 3:00 more of the budget used");
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
    const sealedRemedy = r.remedy as NonNullable<typeof r.remedy>;
    const carrying = (evidenceHash: string) =>
      ({
        op: { kind: "remedy", remedy: 1, overdue_epoch: String(sealedRemedy.epoch), log_len: String(sealedRemedy.log_len), strike: sealedRemedy.strike, final_at: remedyTimes(sealedRemedy).finalAt.toString() },
        msg_json: JSON.stringify({ submit_remedy: { attestation: { evidence_hash: evidenceHash } } }),
      }) as unknown as ChainIntentRecord;
    const intent = carrying(sealedRemedy.evidence_hash);
    const waiting = await h.clock.remedyGate(GAME, intent);
    assert.equal(waiting.kind, "wait");
    assert.match((waiting as { why: string }).why, /annulment/);
    annulOpen = false;
    assert.equal((await h.clock.remedyGate(GAME, intent)).kind, "ok");
    const other = { ...intent, op: { ...intent.op, overdue_epoch: "99" } } as unknown as ChainIntentRecord;
    assert.equal((await h.clock.remedyGate(GAME, other)).kind, "wait", "an intent that is not the sealed decision never passes");
    assert.equal((await h.clock.remedyGate(GAME, carrying("cd".repeat(32)))).kind, "wait", "nor one carrying another evidence hash for the same instance");
  });

  test("REVIEW: a sealed remedy not yet final keeps its table RESIDENT (the sweep carries it on with nobody there, no vote); once final on chain the table is released", async () => {
    let status: "submitted" | "confirmed" = "submitted";
    const port = { configured: true, annulOpen: async () => false, attest: async () => ({ status, detail: null, attested: status === "submitted" }), progress: async () => (status === "confirmed" ? "confirmed" : "open"), fence: () => undefined } as unknown as RemedyPort;
    const pins: boolean[] = [];
    const h = harness({ money: true, remedy: port, pins });
    await h.deal();
    await h.time.advance(LIVE_ACTION_MS + LIVE_CURE_MS);
    await h.clock.idle();
    assert.deepEqual([h.record().phase, h.record().remedy?.status, h.record().system], ["ended", "submitted", null]);
    assert.equal(pins[pins.length - 1], true, "kept resident while the remedy is not final");
    status = "confirmed";
    await h.clock.driveRemedy(GAME);
    assert.equal(h.record().remedy?.status, "confirmed");
    assert.equal(pins[pins.length - 1], false, "released once final on chain");
  });

  test("SEALED APPROVAL FINALITY (Live money): minute 30 reads the approvers' keys AT the final second -- a seat whose key moved at or before it voids its YES (the neutral outcome); none moved seals the foreclosure", async () => {
    const approval = (byte: string) => ({ approve_until: 9_999_999_999, signature: byte.repeat(64) });
    const run = async (answer: readonly string[] | null) => {
      const calls: Array<{ seats: string[]; atSecs: number | undefined }> = [];
      const port = {
        configured: true,
        annulOpen: async () => false,
        attest: async () => ({ status: "sealed", detail: null, attested: false }),
        progress: async () => "none",
        fence: () => undefined,
        staleApprovals: async (_gameId: string, _facts: unknown, approvals: readonly { seat: string }[], options?: { atSecs?: number }) => {
          calls.push({ seats: approvals.map((a) => a.seat), atSecs: options?.atSecs });
          return answer;
        },
      } as unknown as RemedyPort;
      const h = harness({ money: true, remedy: port });
      await h.deal();
      await h.time.advance(LIVE_ACTION_MS);
      await h.clock.idle();
      assert.equal(h.record().overdue?.seat, P1);
      const proposed = await h.serial(() => h.clock.op(h.game, h.tx, { type: "clock-propose", seat: P2, kind: "foreclose", approval: approval("22"), verifiedFor: null, stale: [] }));
      assert.equal(proposed.ok, true, JSON.stringify(proposed));
      const id = h.record().overdue?.proposal?.id as number;
      const voted = await h.serial(() => h.clock.op(h.game, h.tx, { type: "clock-vote", seat: P3, proposalId: id, yes: true, approval: approval("33"), verifiedFor: null, stale: [], renew: false }));
      assert.equal(voted.ok, true, JSON.stringify(voted));
      assert.equal(calls.length, 0, "no key read before minute 30");
      const finalSecs = Math.ceil((T0 + LIVE_ACTION_MS + LIVE_CURE_MS) / 1000);
      await h.time.advance(LIVE_CURE_MS);
      await h.clock.idle();
      assert.deepEqual(calls, [{ seats: [P2, P3], atSecs: finalSecs }], "one read, at the final second");
      return h.record();
    };
    const moved = await run([P3]);
    assert.deepEqual([moved.ended?.kind, moved.remedy?.kind], ["live-timeout-annul", 1], "P3's key moved before the seal: incomplete");
    const kept = await run([]);
    assert.deepEqual([kept.ended?.kind, kept.remedy?.kind], ["live-foreclosure", 2]);
    assert.deepEqual(kept.remedy?.approvals.map((a) => a.seat), [P2, P3]);
  });

  test("SEALED APPROVAL FINALITY (Live money), chain unread: minute 30 is NOT decided on unknown keys -- every move and vote is refused meanwhile (no cure after its moment) -- and once a read is conclusive it is decided AT its own moment", async () => {
    const approval = (byte: string) => ({ approve_until: 9_999_999_999, signature: byte.repeat(64) });
    let answer: readonly string[] | null = null;
    let reads = 0;
    /* A stalled chain read (a halted node: the read waits its whole timeout) -- released by the test. */
    let stall: Promise<void> | null = null;
    const port = {
      configured: true,
      annulOpen: async () => false,
      attest: async () => ({ status: "sealed", detail: null, attested: false }),
      progress: async () => "none",
      fence: () => undefined,
      staleApprovals: async () => {
        reads += 1;
        if (stall !== null) await stall;
        return answer;
      },
    } as unknown as RemedyPort;
    const h = harness({ money: true, remedy: port });
    await h.deal();
    await h.time.advance(LIVE_ACTION_MS);
    await h.clock.idle();
    assert.equal((await h.serial(() => h.clock.op(h.game, h.tx, { type: "clock-propose", seat: P2, kind: "foreclose", approval: approval("22"), verifiedFor: null, stale: [] }))).ok, true);
    const id = h.record().overdue?.proposal?.id as number;
    assert.equal((await h.serial(() => h.clock.op(h.game, h.tx, { type: "clock-vote", seat: P3, proposalId: id, yes: true, approval: approval("33"), verifiedFor: null, stale: [], renew: false }))).ok, true);
    const minute30 = T0 + LIVE_ACTION_MS + LIVE_CURE_MS;
    await h.time.advance(LIVE_CURE_MS);
    await h.clock.idle();
    assert.ok(reads >= 1);
    assert.deepEqual([h.record().phase, h.record().remedy, h.record().ended], ["overdue", null, null], "nothing decided on unknown keys");
    /* PHASE 3 ESCROW 2.1 release readiness: the hold is VISIBLE to the operator -- a count (the ClockFinalityHeldTables
       gauge), one audit line when it begins (game id, epoch, final second: never a key, signature or vote), and the
       per-read counter. */
    assert.equal(h.clock.finalityHeld(), 1, "one table frozen at an undecided minute 30");
    assert.ok(h.clock.counters.finalityKeysUnread >= 1);
    const unread = h.ops.lines.filter((line) => line.event === "clock.finality-keys-unread");
    assert.equal(unread.length, 1, "audited once per hold, not per re-read");
    assert.deepEqual(Object.keys(unread[0]).sort(), ["epoch", "event", "final_secs", "game_id"]);
    assert.equal(unread[0].game_id, GAME);
    assert.ok(!JSON.stringify(unread[0]).includes("22".repeat(64)) && !JSON.stringify(unread[0]).includes("33".repeat(64)), "no approval signature in the audit line");
    /* The defaulter's move after minute 30 is no cure: refused while the decision waits. So is a vote. */
    const late = await h.submit(P1, { PassTurn: { game_id: 1 } });
    assert.deepEqual([late.ok, (late as { code?: string }).code], [false, CLOCK_REFUSAL.unavailable]);
    const veto = await h.serial(() => h.clock.op(h.game, h.tx, { type: "clock-vote", seat: P2, proposalId: id, yes: false, approval: null, verifiedFor: null, stale: [], renew: false }));
    assert.deepEqual([veto.ok, (veto as { code?: string }).code], [false, CLOCK_REFUSAL.unavailable]);
    /* The chain answers: the retry decides minute 30 at its own moment. */
    /* Still unread across further re-reads: still one audit line, still held. */
    await h.time.advance(10 * SEC);
    await h.clock.idle();
    assert.equal(h.ops.lines.filter((line) => line.event === "clock.finality-keys-unread").length, 1);
    /* Review (observability HIGH): while a re-read is IN FLIGHT the table is still frozen -- the gauge must not blink to
       0 (the catch-up clears `finalityPending` before its read returns). */
    let release: () => void = () => undefined;
    stall = new Promise<void>((resolve) => {
      release = resolve;
    });
    await h.time.advance(6 * SEC); // past FINALITY_KEY_REREAD_MS: the next catch-up reads the chain again
    const readsBefore = reads;
    /* A refused move runs the table's catch-up, which re-reads the keys (and clears `finalityPending` meanwhile). */
    const inFlight = h.submit(P1, { PassTurn: { game_id: 1 } });
    for (let i = 0; i < 200 && reads === readsBefore; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(reads > readsBefore, "a re-read is in flight");
    assert.equal(h.clock.finalityHeld(), 1, "still counted while the re-read is in flight");
    stall = null;
    release();
    await inFlight;
    await h.clock.idle();
    assert.equal(h.clock.finalityHeld(), 1);
    answer = [];
    await h.time.advance(40 * SEC);
    await h.clock.idle();
    const r = h.record();
    assert.deepEqual([r.ended?.kind, r.remedy?.kind, r.remedy?.final_ms], ["live-foreclosure", 2, minute30]);
    assert.equal(h.clock.finalityHeld(), 0, "decided: nothing held");
    const read = h.ops.lines.filter((line) => line.event === "clock.finality-keys-read");
    assert.equal(read.length, 1);
    assert.ok(typeof read[0].held_ms === "number" && (read[0].held_ms as number) > 0, "the hold's duration is reported");
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
  test("NO GAMEPLAY HISTORY CAP (owner ruling, 2026-10-07): a money table past 10,000 log entries keeps its clock -- offers stay legal, the overdue still comes naming the cumulative log hash, and its sealed remedy's evidence verifies", async () => {
    const port = {
      configured: true,
      annulOpen: async () => false,
      attest: async () => ({ status: "sealed", detail: null, attested: false }),
      progress: async () => "none",
      fence: () => undefined,
      staleApprovals: async () => [],
    } as unknown as RemedyPort;
    const h = harness({ money: true, remedy: port });
    await h.deal();
    /* 10,200 entries of real, legal play: PRR's president offers to buy the D&H and takes it back, again and again.
       Each offer suspends the proposer (Live) and each rescission resumes the same remainder. */
    const offer = (price: string) => ({ ProposePrivatePurchase: { game_id: 1, private_id: DH, private_name: "x", owner: P2, buyer_protocol_id: PRR, buyer_ticker: "PRR", price } });
    const rescind = { RescindPrivatePurchase: { game_id: 1, private_id: DH } };
    for (let i = 0; h.room.entries.length < 10_200; i += 1) {
      const made = await h.submit(P1, i % 2 === 0 ? offer(String(40 + (i % 7))) : rescind);
      assert.equal(made.ok, true, `move ${i} at ${h.room.entries.length}: ${JSON.stringify(made)}`);
    }
    assert.ok(h.room.entries.length > 10_000);
    /* An offer is still legal past 10,000, and the clock still runs: the overdue comes at 20:00 as on move one. */
    assert.equal((await h.submit(P1, offer("50"))).ok, true);
    assert.equal((await h.submit(P1, rescind)).ok, true);
    await h.time.advance(LIVE_ACTION_MS);
    await h.clock.idle();
    const r = h.record();
    assert.equal(r.phase, "overdue", "the clock is not frozen by the history's length");
    assert.equal(r.overdue?.log_len, h.room.entries.length);
    assert.equal(r.overdue?.log_hash, logHash(h.room.entries), "the overdue names the cumulative log hash of exactly that history");
    /* The N-1 vote and minute 30: the sealed decision's evidence verifies on its own, at this length. */
    const approval = (byte: string) => ({ approve_until: 9_999_999_999, signature: byte.repeat(64) });
    assert.equal((await h.serial(() => h.clock.op(h.game, h.tx, { type: "clock-propose", seat: P2, kind: "foreclose", approval: approval("22"), verifiedFor: null, stale: [] }))).ok, true);
    const id = h.record().overdue?.proposal?.id as number;
    assert.equal((await h.serial(() => h.clock.op(h.game, h.tx, { type: "clock-vote", seat: P3, proposalId: id, yes: true, approval: approval("33"), verifiedFor: null, stale: [], renew: false }))).ok, true);
    await h.time.advance(LIVE_CURE_MS);
    await h.clock.idle();
    const sealed = h.record().remedy;
    assert.ok(sealed !== null);
    assert.equal(sealed.kind, 2);
    assert.deepEqual([sealed.log_len, sealed.log_hash], [h.room.entries.length, logHash(h.room.entries)]);
    assert.equal(sealedRemedyProblem(GAME, sealed), null, "the sealed evidence folds to its hash and names this decision");
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

  test("SEALED APPROVAL FINALITY (Timed Async money): the completing YES is decided AT the instant its approvals were checked under the keys held then -- never without that check, never on a set that changed meanwhile", async () => {
    const approval = (byte: string) => ({ approve_until: 9_999_999_999, signature: byte.repeat(64) });
    const port = {
      configured: true,
      annulOpen: async () => false,
      attest: async () => ({ status: "sealed", detail: null, attested: false }),
      progress: async () => "none",
      fence: () => undefined,
      staleApprovals: async () => [],
    } as unknown as RemedyPort;
    const h = harness({ remedy: port });
    assert.equal((await h.clock.createPolicy(GAME, { deadline: "async-pace", paceSecs: 43_200, money: true })).ok, true);
    await h.deal();
    await h.time.advance(43_200_000);
    await h.clock.idle();
    assert.equal(h.record().overdue?.seat, P1);
    const proposed = await h.serial(() => h.clock.op(h.game, h.tx, { type: "clock-propose", seat: P2, kind: "annul", approval: approval("22"), verifiedFor: null, stale: [] }));
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    const id = h.record().overdue?.proposal?.id as number;
    /* A YES that turns out to complete the set, with no completion check (the host read the table before another
       vote): refused, nothing sealed. */
    const unchecked = await h.serial(() => h.clock.op(h.game, h.tx, { type: "clock-vote", seat: P3, proposalId: id, yes: true, approval: approval("33"), verifiedFor: null, stale: [], renew: false }));
    assert.deepEqual([unchecked.ok, (unchecked as { code?: string }).code], [false, CLOCK_REFUSAL.stale]);
    assert.equal(h.record().remedy, null);
    /* A check read at an older evidence sequence (a vote or veto landed meanwhile): refused. */
    const checkedAt = h.time.now();
    const seq = h.record().evidence.seq;
    const behind = await h.serial(() => h.clock.op(h.game, h.tx, { type: "clock-vote", seat: P3, proposalId: id, yes: true, approval: approval("33"), verifiedFor: null, stale: [], renew: false, checked: { at: checkedAt, seq: seq - 1 } }));
    assert.deepEqual([behind.ok, (behind as { code?: string }).code], [false, CLOCK_REFUSAL.stale]);
    /* The chain wait passes (the key read waits for a block past the second); the decision is stamped AT the checked
       instant, not at the moment the op ran. */
    await h.time.advance(12 * SEC);
    const voted = await h.serial(() => h.clock.op(h.game, h.tx, { type: "clock-vote", seat: P3, proposalId: id, yes: true, approval: approval("33"), verifiedFor: null, stale: [], renew: false, checked: { at: checkedAt, seq } }));
    assert.equal(voted.ok, true, JSON.stringify(voted));
    const r = h.record();
    assert.deepEqual([r.ended?.kind, r.remedy?.kind, r.remedy?.final_ms], ["async-annul", 4, checkedAt]);
    assert.deepEqual(r.remedy?.approvals.map((a) => a.seat), [P2, P3]);
    assert.equal(sealedRemedyProblem(GAME, r.remedy as NonNullable<typeof r.remedy>), null);
  });
});

describe("Owner-policy correction: Live inter-player offers that suspend the proposer; Async keeps no decline limit", () => {
  const offerDH = (price: string) => ({ ProposePrivatePurchase: { game_id: 1, private_id: DH, private_name: "x", owner: P2, buyer_protocol_id: PRR, buyer_ticker: "PRR", price } });
  const answerDH = (accept: boolean) => ({ AnswerPrivatePurchase: { game_id: 1, private_id: DH, accept } });

  test("LIVE: a qualifying NON-train offer (a real private purchase) gets the 10:00 response timer with the proposer frozen exactly; its declines and a train offer's share the one directional counter, and a third qualifying offer is refused before commit", async () => {
    const h = harness();
    await h.deal();
    await h.time.advance(4 * MIN);
    const proposed = await h.submit(P1, offerDH("70"));
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    const privStanding = structuredClone(h.room.state);
    let r = h.record();
    assert.deepEqual([r.obligation?.seat, r.obligation?.trade?.proposer, h.remaining()], [P2, P1, LIVE_TRADE_MS], "the recipient's distinct response timer, not an action clock");
    assert.deepEqual(r.parked.map((p) => [p.seat, p.remaining_ms]), [[P1, 16 * MIN]], "the proposer frozen at its exact remainder");
    assert.equal(h.clock.viewOf(GAME)?.trade?.kind, "private");
    assert.equal(h.clock.offerBlocked(h.game, { actor: P1, board: privStanding }), null, "no declines yet");
    await h.time.advance(3 * MIN);
    assert.equal((await h.submit(P2, answerDH(false))).ok, true);
    r = h.record();
    assert.deepEqual([r.obligation?.seat, h.remaining(), r.declines.counts[`${P1}>${P2}`]], [P1, 16 * MIN, 1], "the proposer resumes exactly; one decline");
    assert.deepEqual(r.strikes, {}, "the response timer is never a strike");
    /* The second decline: a train offer to the same player, left unanswered. */
    await h.submit(P1, proposeTrain(NYC, "2", "50"));
    await h.time.advance(LIVE_TRADE_MS);
    await h.serial(async () => undefined);
    /* (That 10:00 wait went beyond the 7:00 of freeze budget left: its last 3:00 were charged to P1.) */
    assert.deepEqual([h.record().declines.counts[`${P1}>${P2}`], h.remaining(), h.record().obligation?.freeze_ms], [2, 13 * MIN, 0]);
    /* A third qualifying offer P1 -> P2 (any kind), checked on the board the speculation made, before commit. */
    const blocked = h.clock.offerBlocked(h.game, { actor: P1, board: privStanding });
    assert.equal(blocked?.code, CLOCK_REFUSAL.declines);
    assert.equal(blocked?.reason, `${P2} has declined two offers from you this round.`);
    assert.equal(h.clock.offerBlocked(h.game, { actor: P2, board: privStanding }), null, "only the proposer named by the board is judged");
    const third = await h.submit(P1, proposeTrain(NYC, "2", "70"));
    assert.equal((third as { code: string }).code, CLOCK_REFUSAL.declines, "the train's own pre-speculation check: the owner's sentence");
    assert.equal((third as { reason: string }).reason, declinesReachedSentence(P2));
    /* Another player stays open. */
    const other = await h.submit(P1, proposeTrain(CO, "3", "100"));
    assert.equal(other.ok, true, `another direction is open: ${JSON.stringify(other)}`);
  });

  test("ASYNC: repeated rejected legal offers stay available -- no decline counter, no 10:00 response timer, nothing blocked before commit", async () => {
    const h = harness();
    assert.equal((await h.clock.createPolicy(GAME, { deadline: "async-pace", paceSecs: 43_200, money: false })).ok, true);
    await h.deal();
    for (let n = 0; n < 4; n += 1) {
      const proposed = await h.submit(P1, n % 2 === 0 ? offerDH(String(70 + n)) : proposeTrain(NYC, "2", String(50 + n)));
      assert.equal(proposed.ok, true, `offer ${n + 1}: ${JSON.stringify(proposed)}`);
      const r = h.record();
      assert.deepEqual([r.obligation?.seat, r.obligation?.trade ?? null], [P2, null], "the answerer owes an ordinary pace obligation");
      assert.equal(h.clock.offerBlocked(h.game, { actor: P1, board: h.room.state }), null, "Async never blocks an offer");
      const answered = await h.submit(P2, n % 2 === 0 ? answerDH(false) : answerTrain(NYC, false));
      assert.equal(answered.ok, true, JSON.stringify(answered));
    }
    assert.deepEqual(h.record().declines.counts, {}, "no decline count in Async");
    assert.deepEqual(h.clock.viewOf(GAME)?.declines, []);
  });

  test("ASYNC (last correction review): an offer never extends the proposer's deadline -- at it the SERVER closes the offer (a real engine rescission, stamped at that moment) and the proposer, not the answerer, is overdue", async () => {
    const h = harness();
    assert.equal((await h.clock.createPolicy(GAME, { deadline: "async-pace", paceSecs: 43_200, money: false })).ok, true);
    await h.deal();
    const deadline = T0 + 43_200_000;
    await h.time.advance(43_200_000 - 10 * MIN);
    await h.clock.idle();
    assert.equal((await h.submit(P1, offerDH("40"))).ok, true);
    assert.deepEqual(h.record().parked.map((p) => [p.seat, p.remaining_ms]), [[P1, 10 * MIN]], "P1's last 10 minutes, parked RUNNING");
    assert.deepEqual(h.clock.viewOf(GAME)?.running, [{ seat: P1, remainingMs: 10 * MIN }]);
    await h.time.advance(10 * MIN);
    await h.clock.idle();
    const r = h.record();
    assert.deepEqual([r.phase, r.overdue?.seat, r.overdue?.at], ["overdue", P1, deadline], "the proposer is overdue exactly at its own deadline");
    assert.equal(r.strikes[P2] ?? 0, 0);
    const last = h.room.entries[h.room.entries.length - 1];
    assert.equal(last.at, deadline, "the server's rescission is stamped at the deadline");
    assert.equal(JSON.parse(last.payload).RescindPrivatePurchase !== undefined, true, JSON.stringify(last.payload));
  });
});
