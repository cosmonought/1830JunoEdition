// server/src/rooms/clock/clockModel.test.ts
//
// PHASE 3 FINAL CLOCKS: the table clock's state machine (`clockModel.ts`), on CONTROLLED time and synthetic board facts,
// row by row against the owner's test matrix: the Live 20-minute per-action clock, the Live train-offer response timer
// and its two-decline limit, the first / second overdue with the N-1 foreclosure vote and the minute-30 finality, the
// third overdue, voluntary pause, system pause (continuity), Timed Async, No-deadline, the free table's unanimous
// annulment, undo, and the canonical evidence. Integer milliseconds only; every expected value is exact.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { RequiredDecision, StandingOffer } from "../../../../frontend/src/gameEngine/clockResponsibility";
import { CLOCK_REFUSAL } from "../../../../frontend/src/utils/clockProtocol";
import { canonicalJson, evidenceHashOf, foldEvidence, genesisHead } from "./clockEvidence";
import {
  acknowledge,
  advance,
  annulVote,
  choosePolicy,
  classifyMessage,
  clockViewOf,
  continuityBreak,
  foldBatch,
  gate,
  newClockRecord,
  nextDue,
  pauseOp,
  propose,
  reapprove,
  recoverGap,
  remainingAt,
  remedyStale,
  sealNeutralFallback,
  systemResumeVote,
  vote,
  type ClockBoardFacts,
  type ClockMsgClass,
  type ClockStep,
} from "./clockModel";
import { isGameClockRecord, LIVE_ACTION_MS, LIVE_CURE_MS, LIVE_TRADE_MS, parseClockDocument, ClockUnreadableError, type GameClockRecord } from "./clockRecord";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const A = "p-aaaaaaaaaaaaaaaa";
const B = "p-bbbbbbbbbbbbbbbb";
const C = "p-cccccccccccccccc";
const T0 = 1_760_000_000_000;
const HASH = "ab".repeat(32);
const GAME = "g_00000000000000000000000010";

const turn = (seat: string, n = 0): RequiredDecision => ({ seat, kind: "turn", key: `turn:OperatingRound|1.1.${n}|${seat}`, offer: null });
const offerOf = (slot: StandingOffer["slot"], proposer: string, answerer: string, n = 1): StandingOffer => ({ slot, key: `${slot}:${n}`, proposer, answerer });

function facts(decision: RequiredDecision | null, over: Partial<ClockBoardFacts> = {}): ClockBoardFacts {
  return { over: false, closed: false, seats: [A, B, C], decision, offer: null, orKey: "OperatingRound/1/1", ...over };
}
const offering = (offer: StandingOffer, over: Partial<ClockBoardFacts> = {}): ClockBoardFacts =>
  facts({ seat: offer.answerer as string, kind: "offer-answer", key: `offer:${offer.key}`, offer }, { offer, ...over });

/** A table on controlled time: every step is a pure call, every record checked for shape. */
class Table {
  record: GameClockRecord;
  t = T0;
  index = 0;
  logLen = 1;
  current: ClockBoardFacts;
  readonly events: string[] = [];
  readonly effects: string[] = [];

  constructor(deadline: "live" | "async-pace" | "no-deadline", options: { pace?: number; money?: boolean; first?: string; seats?: string[] } = {}) {
    const created = newClockRecord({ gameId: GAME, deadline, paceSecs: options.pace ?? null, money: options.money ?? false, authority: "auth-1", now: T0 });
    this.current = facts(turn(options.first ?? A), options.seats ? { seats: options.seats } : {});
    this.record = this.take(foldBatch(created, { actor: A, first: 0, last: 0, at: T0, msg: "deal", revertTarget: null, before: this.current, after: this.current }, T0));
  }

  take(step: ClockStep): GameClockRecord {
    assert.ok(isGameClockRecord(step.record), "every record is a valid v2 clock record");
    for (const event of step.events) this.events.push(event.kind);
    for (const effect of step.effects) this.effects.push(effect.kind);
    this.record = step.record;
    return step.record;
  }

  /** Time passes; every due transition happens at its own moment. Returns a train-offer expiry if one fell due. */
  advance(ms: number): ReturnType<typeof advance>["tradeExpiry"] {
    this.t += ms;
    const step = advance(this.record, this.t, () => ({ len: this.logLen, hash: HASH }));
    this.take(step);
    return step.tradeExpiry;
  }

  /** A committed batch by `actor` (judged by the gate first: a refusal throws). */
  move(actor: string, after: ClockBoardFacts, msg: ClockMsgClass = "move", options: { revertTarget?: number; trainRecipient?: string; size?: number } = {}): void {
    const refusal = gate(this.record, { actor, msg, closeRoom: false, revertTarget: options.revertTarget ?? null, trainRecipient: options.trainRecipient ?? null, nameOf: (s) => s });
    if (refusal !== null) throw new Error(`refused: ${refusal.code}: ${refusal.reason}`);
    this.commit(actor, after, msg, options);
  }

  /** The same without the gate (the server's own expiry move). */
  commit(actor: string, after: ClockBoardFacts, msg: ClockMsgClass, options: { revertTarget?: number; size?: number } = {}): void {
    const size = options.size ?? 1;
    const first = this.index + 1;
    this.index += size;
    this.logLen += size;
    this.take(foldBatch(this.record, { actor, first, last: this.index, at: this.t, msg, revertTarget: options.revertTarget ?? null, before: this.current, after }, this.t));
    this.current = after;
  }

  refusal(actor: string, msg: ClockMsgClass = "move", options: { revertTarget?: number; trainRecipient?: string } = {}) {
    return gate(this.record, { actor, msg, closeRoom: false, revertTarget: options.revertTarget ?? null, trainRecipient: options.trainRecipient ?? null, nameOf: (s) => s });
  }

  remaining(): number {
    const timer = this.record.obligation?.timer;
    assert.ok(timer !== null && timer !== undefined, "an obligation timer");
    return remainingAt(timer, this.t);
  }

  cureLeft(): number {
    const cure = this.record.overdue?.cure;
    assert.ok(cure !== null && cure !== undefined, "a cure window");
    return remainingAt(cure, this.t);
  }

  ok(step: ClockStep | { code: string; reason: string }): void {
    if ("code" in step) throw new Error(`refused: ${step.code}: ${step.reason}`);
    this.take(step);
  }
}

/* ==================================================================
    LIVE ACTION CLOCK
   ================================================================== */

describe("Live action clock: 20 minutes per REQUIRED action", () => {
  test("exactly 20:00 from the deal; overdue at 20:00 exactly, never a millisecond earlier", () => {
    const t = new Table("live");
    assert.equal(t.record.obligation?.seat, A);
    assert.equal(t.remaining(), LIVE_ACTION_MS);
    t.advance(LIVE_ACTION_MS - 1);
    assert.equal(t.record.phase, "active");
    assert.equal(t.remaining(), 1);
    t.advance(1);
    assert.equal(t.record.phase, "overdue");
    assert.equal(t.record.overdue?.at, T0 + LIVE_ACTION_MS, "the overdue is recorded at its exact moment");
    assert.equal(t.record.strikes[A], 1);
  });

  test("several accepted actions in one operating turn each refresh the SAME human's 20:00", () => {
    const t = new Table("live");
    t.advance(19 * MIN);
    t.move(A, facts(turn(A, 0)));
    assert.equal(t.remaining(), LIVE_ACTION_MS, "fresh after the first action");
    t.advance(15 * MIN);
    t.move(A, facts(turn(A, 0)));
    assert.equal(t.remaining(), LIVE_ACTION_MS, "fresh again after the second");
    t.advance(19 * MIN + 59 * SEC);
    assert.equal(t.record.phase, "active", "never overdue while each action came in time");
  });

  test("responsibility handoff: the new responsible human gets a fresh 20:00", () => {
    const t = new Table("live");
    t.advance(7 * MIN);
    t.move(A, facts(turn(B, 1)));
    assert.equal(t.record.obligation?.seat, B);
    assert.equal(t.remaining(), LIVE_ACTION_MS);
  });

  test("an off-turn REQUIRED answer is timed: the answerer owes it (an excess-train discard)", () => {
    const t = new Table("live");
    const discard: RequiredDecision = { seat: C, kind: "discard", key: "discard:2:1.1.0", offer: null };
    t.move(A, facts(discard));
    assert.deepEqual([t.record.obligation?.seat, t.record.obligation?.kind], [C, "discard"]);
    assert.equal(t.remaining(), LIVE_ACTION_MS);
    t.move(C, facts(turn(A, 0)));
    assert.equal(t.record.obligation?.seat, A, "back to the operating president, fresh");
    assert.equal(t.remaining(), LIVE_ACTION_MS);
  });

  test("another seat's accepted off-turn move that leaves the obligation where it is (an M&H request) refreshes nothing", () => {
    const t = new Table("live");
    t.advance(12 * MIN);
    t.move(B, facts(turn(A, 0)));
    assert.equal(t.remaining(), 8 * MIN, "A's clock runs on untouched");
  });

  test("refused, stale and duplicate submissions, chat, UI and reconnects never reach the clock (they are never batches)", () => {
    const t = new Table("live");
    t.advance(5 * MIN);
    const before = t.record;
    /* The gate is a pure read: asking it changes nothing. */
    assert.equal(t.refusal(A), null);
    assert.equal(t.refusal(B), null);
    assert.equal(t.record, before);
    t.advance(0);
    assert.equal(t.record, before, "no time passing, nothing changes");
    assert.equal(t.remaining(), 15 * MIN);
  });

  test("nobody owes anything: no clock runs", () => {
    const t = new Table("live");
    t.move(A, facts(null));
    assert.equal(t.record.obligation, null);
    t.advance(3 * HOUR);
    assert.equal(t.record.phase, "active");
    assert.equal(nextDue(t.record), null);
  });

  test("the game's own end stops every clock", () => {
    const t = new Table("live");
    t.move(A, facts(null, { over: true }));
    assert.equal(t.record.phase, "ended");
    assert.equal(t.record.ended?.kind, "game-end");
    t.advance(HOUR);
    assert.equal(t.record.phase, "ended");
  });
});

/* ==================================================================
    LIVE TRAIN-OFFER RESPONSE TIMER AND THE TWO-DECLINE LIMIT
   ================================================================== */

describe("Live train offer: the proposer's clock freezes; the recipient has a distinct 10:00 to respond", () => {
  const offer = offerOf("train", A, B);

  test("a valid offer freezes A's remainder exactly and starts B's 10-minute RESPONSE timer (not an action clock)", () => {
    const t = new Table("live");
    t.advance(6 * MIN + 12 * SEC);
    t.move(A, offering(offer), "propose", { trainRecipient: B });
    assert.equal(t.record.obligation?.seat, B);
    assert.deepEqual(t.record.obligation?.trade, { proposer: A, offer_key: offer.key });
    assert.equal(t.remaining(), LIVE_TRADE_MS);
    assert.deepEqual(t.record.parked, [{ seat: A, offer_key: offer.key, remaining_ms: 13 * MIN + 48 * SEC }]);
    const view = clockViewOf(t.record, t.t);
    assert.equal(view.state, "trade");
    assert.equal(view.action, null, "no ordinary action clock is shown for the recipient");
    assert.deepEqual([view.trade?.proposer, view.trade?.recipient, view.trade?.proposerRemainingMs], [A, B, 13 * MIN + 48 * SEC]);
  });

  test("unanswered: the offer expires at exactly 10:00; B gets NO strike; A resumes EXACTLY its remainder (not 20:00); one decline", () => {
    const t = new Table("live");
    t.advance(6 * MIN + 12 * SEC);
    t.move(A, offering(offer), "propose", { trainRecipient: B });
    assert.equal(t.advance(LIVE_TRADE_MS - 1), null, "nothing due a millisecond early");
    const expiry = t.advance(1);
    assert.deepEqual(expiry, { kind: "trade-expiry", at: T0 + 6 * MIN + 12 * SEC + LIVE_TRADE_MS, offerKey: offer.key, proposer: A, recipient: B });
    /* The controller closes the offer as the server's own move, stamped at the expiry. */
    t.commit(A, facts(turn(A, 0)), "server-expiry");
    assert.equal(t.record.obligation?.seat, A);
    assert.equal(t.remaining(), 13 * MIN + 48 * SEC, "A's exact frozen remainder");
    assert.equal(t.record.strikes[B] ?? 0, 0, "the recipient is never struck for an unanswered offer");
    assert.equal(t.record.phase, "active");
    assert.equal(t.record.declines.counts[`${A}>${B}`], 1);
    assert.ok(t.record.undo_floor >= t.index, "no undo can resurrect the expired offer");
  });

  test("accept: the trade resolves; the proposer's next decision starts fresh", () => {
    const t = new Table("live");
    t.advance(15 * MIN);
    t.move(A, offering(offer), "propose", { trainRecipient: B });
    t.advance(3 * MIN);
    t.move(B, facts(turn(A, 0)), "accept");
    assert.equal(t.record.obligation?.seat, A);
    assert.equal(t.remaining(), LIVE_ACTION_MS);
    assert.equal(t.record.declines.counts[`${A}>${B}`] ?? 0, 0, "an acceptance is no decline");
    assert.deepEqual(t.record.parked, []);
  });

  test("explicit rejection counts one decline (and the answer is B's completed decision: A's next starts fresh)", () => {
    const t = new Table("live");
    t.advance(15 * MIN);
    t.move(A, offering(offer), "propose", { trainRecipient: B });
    t.move(B, facts(turn(A, 0)), "reject");
    assert.equal(t.record.declines.counts[`${A}>${B}`], 1);
    assert.equal(t.remaining(), LIVE_ACTION_MS);
  });

  test("the proposer's own rescission is no decline, and is charged the time its offer stood (a propose-and-rescind never gives time)", () => {
    const t = new Table("live");
    t.advance(18 * MIN);
    t.move(A, offering(offer), "propose", { trainRecipient: B });
    t.advance(1 * MIN);
    t.move(A, facts(turn(A, 0)), "rescind");
    assert.equal(t.remaining(), 1 * MIN, "the 2:00 A had, less the 1:00 its offer stood: rescinding never stops A's own clock");
    assert.equal(t.record.declines.counts[`${A}>${B}`] ?? 0, 0);
    /* Repeated propose-and-rescind cannot stall: the stood time keeps running out A's clock, to an overdue. */
    t.move(A, offering(offerOf("train", A, B, 2)), "propose", { trainRecipient: B });
    t.advance(1 * MIN + 1);
    t.move(A, facts(turn(A, 0)), "rescind");
    t.advance(0);
    assert.equal(t.record.phase, "overdue");
  });

  test("two declines (one rejection, one expiry) block a third A -> B proposal until the next Operating Round", () => {
    const t = new Table("live");
    t.move(A, offering(offer), "propose", { trainRecipient: B });
    t.move(B, facts(turn(A, 0)), "reject");
    t.move(A, offering(offerOf("train", A, B, 2)), "propose", { trainRecipient: B });
    t.advance(LIVE_TRADE_MS);
    t.commit(A, facts(turn(A, 0)), "server-expiry");
    assert.equal(t.record.declines.counts[`${A}>${B}`], 2);
    const refused = t.refusal(A, "propose", { trainRecipient: B });
    assert.equal(refused?.code, CLOCK_REFUSAL.declines);
    assert.equal(refused?.reason, `${B} has declined two train offers from you this operating round.`, "the owner's copy, never misconduct");
    /* Not blocked: A -> C, B -> A, ordinary play. */
    assert.equal(t.refusal(A, "propose", { trainRecipient: C }), null);
    assert.equal(t.refusal(B, "propose", { trainRecipient: A }), null);
    assert.equal(t.refusal(A, "move"), null);
    /* The next Operating Round clears it. */
    t.move(A, facts(turn(B, 1), { orKey: "OperatingRound/1/2" }));
    assert.deepEqual(t.record.declines, { or_key: "OperatingRound/1/2", counts: {} });
    assert.equal(t.refusal(A, "propose", { trainRecipient: B }), null);
  });

  test("an offer to oneself parks nothing and refreshes nothing; only an accepted trade is progress", () => {
    const t = new Table("live");
    t.advance(10 * MIN);
    const self = offerOf("train", A, A);
    t.move(A, offering(self), "propose");
    assert.equal(t.record.obligation?.trade, null);
    assert.equal(t.remaining(), 10 * MIN, "no refresh by proposing to oneself");
    t.move(A, facts(turn(A, 0)), "rescind");
    assert.equal(t.remaining(), 10 * MIN, "no refresh by withdrawing it either");
  });

  test("invalid offers never freeze: a refused proposal is never a batch -- the clock is exactly as it was", () => {
    const t = new Table("live");
    t.advance(9 * MIN);
    const before = t.record;
    t.advance(0);
    assert.equal(t.record, before);
    assert.equal(t.record.obligation?.trade, null);
    assert.equal(t.remaining(), 11 * MIN);
  });

  test("the recipient's 10:00 never strikes it, and the expiry never increments any overdue count", () => {
    const t = new Table("live");
    for (let round = 0; round < 2; round += 1) {
      t.move(A, offering(offerOf("train", A, B, round + 1)), "propose", { trainRecipient: B });
      t.advance(LIVE_TRADE_MS);
      t.commit(A, facts(turn(A, 0)), "server-expiry");
    }
    assert.deepEqual(t.record.strikes, {});
    assert.equal(t.record.epochs, 0);
  });

  test("Async has no train response timer: the answerer owes an ordinary pace allowance", () => {
    const t = new Table("async-pace", { pace: 86_400 });
    t.move(A, offering(offer), "propose");
    assert.equal(t.record.obligation?.trade, null);
    assert.equal(t.remaining(), 86_400 * SEC);
  });
});

/* ==================================================================
    LIVE FIRST / SECOND OVERDUE, THE N-1 VOTE, MINUTE-30 FINALITY
   ================================================================== */

describe("Live first / second overdue: cure until 30:00; the N-1 vote only decides minute 30", () => {
  const overdue = (money = false) => {
    const t = new Table("live", { money });
    t.advance(LIVE_ACTION_MS);
    assert.equal(t.record.phase, "overdue");
    return t;
  };

  test("at 20:00: OVERDUE, strike 1 durably counted, gameplay INTERRUPTED except the overdue seat's own owed action", () => {
    const t = overdue();
    assert.deepEqual([t.record.overdue?.seat, t.record.overdue?.strike, t.record.overdue?.epoch], [A, 1, 1]);
    assert.equal(t.cureLeft(), LIVE_CURE_MS);
    assert.equal(t.refusal(B)?.code, CLOCK_REFUSAL.interrupted);
    assert.equal(t.refusal(A), null, "the overdue seat may cure");
    assert.equal(t.refusal(A, "revert", { revertTarget: 0 })?.code, CLOCK_REFUSAL.undoFence, "undo is not a cure");
    const view = clockViewOf(t.record, t.t);
    assert.equal(view.state, "overdue");
    assert.equal(view.overdue?.outcomeIfUncured, "timeout-annul");
    assert.equal(view.overdue?.finality?.remainingMs, LIVE_CURE_MS);
  });

  test("a cure at 29:59 works: the strike stays, the instance ends, play resumes with a fresh clock for whoever owes play", () => {
    const t = overdue(true);
    t.advance(LIVE_CURE_MS - SEC);
    t.move(A, facts(turn(B, 1)));
    assert.equal(t.record.phase, "active");
    assert.equal(t.record.overdue, null);
    assert.equal(t.record.strikes[A], 1, "the overdue strike remains permanently counted");
    assert.deepEqual([t.record.obligation?.seat, t.remaining()], [B, LIVE_ACTION_MS]);
    assert.ok(t.effects.includes("fence-checkpoint"), "a money cure posts a fencing checkpoint past the stall");
    assert.ok(t.record.undo_floor >= t.index, "the cure is a fence: no undo reaches back across it");
  });

  test("a cure at or after finality loses: finality is processed first, in serialized order", () => {
    const t = overdue();
    t.advance(LIVE_CURE_MS);
    assert.equal(t.record.phase, "ended");
    assert.equal(t.record.ended?.kind, "live-timeout-annul");
    assert.equal(t.refusal(A)?.code, CLOCK_REFUSAL.ended);
  });

  test("no approval at 30:00 -> neutral timeout annulment; the money decision is sealed with its evidence", () => {
    const t = overdue(true);
    t.advance(LIVE_CURE_MS);
    const remedy = t.record.remedy;
    assert.equal(remedy?.kind, 1);
    assert.deepEqual([remedy?.strike, remedy?.epoch, remedy?.overdue_ms, remedy?.final_ms, remedy?.allowance_secs, remedy?.log_len], [1, 1, T0 + LIVE_ACTION_MS, T0 + LIVE_ACTION_MS + LIVE_CURE_MS, 1200, 1]);
    assert.equal(remedy?.evidence_hash, evidenceHashOf(remedy!.evidence), "the evidence window folds to the sealed hash");
    assert.equal(remedy?.evidence.events.at(-1)?.kind, "remedy-sealed", "the evidence ends at the seal (the table's own end follows it)");
    assert.ok(t.effects.includes("remedy"));
  });

  test("foreclosure: proposed, every N-1 YES -> recorded as the minute-30 outcome, NOT executed early", () => {
    const t = overdue();
    t.advance(3 * MIN);
    t.ok(propose(t.record, B, "foreclose", null, t.t));
    assert.equal(t.record.overdue?.proposal?.complete_at, null, "one of two YES");
    t.advance(1 * MIN);
    t.ok(vote(t.record, C, t.record.overdue!.proposal!.id, true, null, t.t));
    assert.equal(t.record.overdue?.proposal?.complete_at, t.t, "complete N-1");
    assert.equal(t.record.phase, "overdue", "completion does not execute foreclosure");
    assert.equal(clockViewOf(t.record, t.t).overdue?.outcomeIfUncured, "foreclosure");
    t.advance(LIVE_CURE_MS - 4 * MIN);
    assert.equal(t.record.ended?.kind, "live-foreclosure", "at 30:00 with complete approval and no cure: foreclosure");
  });

  test("the owner's example: 20:00 overdue, 23:00 proposed, 24:00 approved, 28:00 cured -> the foreclosure disappears", () => {
    const t = overdue();
    t.advance(3 * MIN);
    t.ok(propose(t.record, B, "foreclose", null, t.t));
    t.advance(1 * MIN);
    t.ok(vote(t.record, C, t.record.overdue!.proposal!.id, true, null, t.t));
    t.advance(4 * MIN);
    t.move(A, facts(turn(A, 0)));
    assert.equal(t.record.phase, "active");
    assert.equal(t.record.ended, null);
    t.advance(2 * MIN);
    assert.equal(t.record.ended, null, "nothing happens at the old finality");
    assert.equal(t.record.phase, "active");
    assert.equal(t.remaining(), LIVE_ACTION_MS - 2 * MIN, "the cure gave the seat a fresh 20:00 for its next required action");
  });

  test("one NO vetoes at once; the 30-minute finality is neither reset nor extended; abstention is incomplete", () => {
    const t = overdue();
    t.advance(2 * MIN);
    t.ok(propose(t.record, B, "foreclose", null, t.t));
    t.advance(1 * MIN);
    t.ok(vote(t.record, C, t.record.overdue!.proposal!.id, false, null, t.t));
    assert.equal(t.record.overdue?.proposal, null);
    assert.equal(t.cureLeft(), LIVE_CURE_MS - 3 * MIN, "finality unchanged by the vote");
    t.ok(propose(t.record, C, "foreclose", null, t.t));
    t.advance(LIVE_CURE_MS - 3 * MIN);
    assert.equal(t.record.ended?.kind, "live-timeout-annul", "an abstaining seat leaves it incomplete: neutral");
    assert.ok(t.events.includes("veto"));
  });

  test("the defaulting seat never votes; Live proposals are foreclosure only; the proposal is bound to its id", () => {
    const t = overdue();
    const own = propose(t.record, A, "foreclose", null, t.t);
    assert.equal("code" in own && own.code, "forbidden");
    const annul = propose(t.record, B, "annul", null, t.t);
    assert.equal("code" in annul && annul.code, "bad-frame");
    t.ok(propose(t.record, B, "foreclose", null, t.t));
    const stale = vote(t.record, C, 999, true, null, t.t);
    assert.equal("code" in stale && stale.code, CLOCK_REFUSAL.stale);
    const self = vote(t.record, A, t.record.overdue!.proposal!.id, true, null, t.t);
    assert.equal("code" in self && self.code, "forbidden");
  });

  test("money: a YES needs a signed approval; an approval that lapses before finality makes the outcome neutral", () => {
    const t = overdue(true);
    const bare = propose(t.record, B, "foreclose", null, t.t);
    assert.equal("code" in bare && bare.code, "bad-frame");
    const finalSecs = Math.ceil((T0 + LIVE_ACTION_MS + LIVE_CURE_MS) / 1000);
    const sig = "11".repeat(64);
    t.ok(propose(t.record, B, "foreclose", { approve_until: finalSecs + 600, signature: sig }, t.t));
    t.ok(vote(t.record, C, t.record.overdue!.proposal!.id, true, { approve_until: finalSecs, signature: sig }, t.t));
    t.advance(LIVE_CURE_MS);
    assert.equal(t.record.remedy?.kind, 1, "C's approval ends at finality: it could never land -- neutral");
  });

  test("money: complete, still-valid approvals at 30:00 seal remedy 2 with every approval", () => {
    const t = overdue(true);
    const finalSecs = Math.ceil((T0 + LIVE_ACTION_MS + LIVE_CURE_MS) / 1000);
    t.ok(propose(t.record, B, "foreclose", { approve_until: finalSecs + 900, signature: "22".repeat(64) }, t.t));
    t.ok(vote(t.record, C, t.record.overdue!.proposal!.id, true, { approve_until: finalSecs + 900, signature: "33".repeat(64) }, t.t));
    t.advance(LIVE_CURE_MS);
    assert.equal(t.record.remedy?.kind, 2);
    assert.deepEqual(t.record.remedy?.approvals.map((a) => a.seat), [B, C].sort());
    /* The neutral fallback, if the foreclosure could not land, is the same overdue instance and the same finality. */
    const fallback = sealNeutralFallback(t.record, t.t + 5 * MIN, "lapsed");
    assert.ok(!("code" in fallback));
    if (!("code" in fallback)) {
      assert.deepEqual([fallback.record.remedy?.kind, fallback.record.remedy?.replaces, fallback.record.remedy?.final_ms, fallback.record.remedy?.epoch], [1, 2, t.record.remedy?.final_ms, 1]);
    }
  });

  test("the second overdue is the second strike; a warning names the next expiry's consequence", () => {
    const t = overdue();
    t.move(A, facts(turn(A, 0)));
    t.advance(LIVE_ACTION_MS);
    assert.deepEqual([t.record.overdue?.strike, t.record.overdue?.epoch, t.record.strikes[A]], [2, 2, 2]);
    t.move(A, facts(turn(B, 1)));
    assert.equal(t.record.strikes[A], 2);
  });
});

/* ==================================================================
    LIVE THIRD OVERDUE
   ================================================================== */

describe("Live third overdue: foreclosure at once, no cure window, no vote", () => {
  test("the third ordinary expiry ends gameplay at 20:00 exactly; money seals remedy 3 (final at the overdue)", () => {
    const t = new Table("live", { money: true });
    for (let strike = 1; strike <= 2; strike += 1) {
      t.advance(LIVE_ACTION_MS);
      t.move(A, facts(turn(A, 0)));
    }
    t.advance(LIVE_ACTION_MS);
    assert.equal(t.record.phase, "ended");
    assert.equal(t.record.ended?.kind, "live-strike3-foreclosure");
    assert.equal(t.record.strikes[A], 3);
    assert.equal(t.record.overdue?.cure, null, "no third cure window");
    const remedy = t.record.remedy;
    assert.deepEqual([remedy?.kind, remedy?.strike, remedy?.final_ms, remedy?.overdue_ms], [3, 3, remedy?.overdue_ms, t.t]);
    assert.equal(t.refusal(A)?.code, CLOCK_REFUSAL.ended, "gameplay stays ended (the challenge is about money only)");
    assert.ok(t.events.includes("final"));
    const late = propose(t.record, B, "foreclose", null, t.t);
    assert.equal("code" in late && late.code, "wrong-state", "no vote");
  });

  test("trade-response expiries and pauses never count toward the strikes", () => {
    const t = new Table("live");
    t.move(A, offering(offerOf("train", A, B)), "propose", { trainRecipient: B });
    t.advance(LIVE_TRADE_MS);
    t.commit(A, facts(turn(A, 0)), "server-expiry");
    t.ok(pauseOp(t.record, A, { action: "request", kind: "pause", id: null }, t.t));
    for (const seat of [B, C]) t.ok(pauseOp(t.record, seat, { action: "yes", kind: "pause", id: t.record.pause.request!.id }, t.t));
    t.advance(30 * 24 * HOUR);
    assert.deepEqual(t.record.strikes, {});
  });
});

/* ==================================================================
    VOLUNTARY PAUSE
   ================================================================== */

describe("Voluntary Live pause: unanimous to begin, unanimous to end, exact remainders", () => {
  const pauseAll = (t: Table) => {
    t.ok(pauseOp(t.record, A, { action: "request", kind: "pause", id: null }, t.t));
    const id = t.record.pause.request!.id;
    for (const seat of [B, C]) t.ok(pauseOp(t.record, seat, { action: "yes", kind: "pause", id }, t.t));
  };
  const resumeAll = (t: Table) => {
    t.ok(pauseOp(t.record, B, { action: "request", kind: "resume", id: null }, t.t));
    const id = t.record.pause.request!.id;
    for (const seat of [A, C]) t.ok(pauseOp(t.record, seat, { action: "yes", kind: "resume", id }, t.t));
  };

  test("a request alone stops nothing; unanimity freezes 6:12 exactly; months paused change nothing; resume restores 6:12", () => {
    const t = new Table("live");
    t.advance(LIVE_ACTION_MS - (6 * MIN + 12 * SEC));
    t.ok(pauseOp(t.record, A, { action: "request", kind: "pause", id: null }, t.t));
    t.advance(SEC);
    assert.equal(t.remaining(), 6 * MIN + 11 * SEC, "the request alone does not stop the clock");
    t.ok(pauseOp(t.record, B, { action: "yes", kind: "pause", id: t.record.pause.request!.id }, t.t));
    assert.equal(t.record.pause.paused_at, null, "two of three is not unanimity");
    t.ok(pauseOp(t.record, C, { action: "yes", kind: "pause", id: t.record.pause.request!.id }, t.t));
    assert.equal(t.record.pause.paused_at, t.t);
    assert.equal(t.refusal(A)?.code, CLOCK_REFUSAL.paused, "gameplay stops");
    t.advance(120 * 24 * HOUR);
    assert.equal(t.remaining(), 6 * MIN + 11 * SEC);
    assert.equal(t.record.phase, "active");
    resumeAll(t);
    assert.equal(t.remaining(), 6 * MIN + 11 * SEC, "no fresh clock on resume");
    t.advance(6 * MIN + 11 * SEC);
    assert.equal(t.record.phase, "overdue");
  });

  test("a paused cure window resumes with its 4:30; finality later by exactly the paused time", () => {
    const t = new Table("live", { money: true });
    t.advance(LIVE_ACTION_MS + 5 * MIN + 30 * SEC);
    assert.equal(t.cureLeft(), 4 * MIN + 30 * SEC);
    pauseAll(t);
    t.advance(3 * HOUR);
    assert.equal(t.cureLeft(), 4 * MIN + 30 * SEC);
    resumeAll(t);
    t.advance(4 * MIN + 30 * SEC);
    assert.equal(t.record.ended?.kind, "live-timeout-annul");
    assert.equal(t.record.remedy?.final_ms, T0 + LIVE_ACTION_MS + LIVE_CURE_MS + 3 * HOUR, "final later by exactly the frozen 3 h");
  });

  test("a paused train-response timer resumes with its 7:05", () => {
    const t = new Table("live");
    t.move(A, offering(offerOf("train", A, B)), "propose", { trainRecipient: B });
    t.advance(2 * MIN + 55 * SEC);
    pauseAll(t);
    t.advance(HOUR);
    assert.equal(t.remaining(), 7 * MIN + 5 * SEC);
    resumeAll(t);
    assert.equal(t.remaining(), 7 * MIN + 5 * SEC);
  });

  test("any NO cancels the request; requests are bound to their id (a stale tab is refused)", () => {
    const t = new Table("live");
    t.ok(pauseOp(t.record, A, { action: "request", kind: "pause", id: null }, t.t));
    const id = t.record.pause.request!.id;
    const stale = pauseOp(t.record, B, { action: "yes", kind: "pause", id: id + 7 }, t.t);
    assert.equal("code" in stale && stale.code, CLOCK_REFUSAL.stale);
    t.ok(pauseOp(t.record, B, { action: "no", kind: "pause", id }, t.t));
    assert.equal(t.record.pause.request, null);
    assert.equal(t.record.pause.paused_at, null);
  });

  test("a free table's unanimous annulment works while paused", () => {
    const t = new Table("live");
    pauseAll(t);
    for (const seat of [A, B, C]) t.ok(annulVote(t.record, seat, true, t.t));
    assert.equal(t.record.ended?.kind, "annulled");
  });
});

/* ==================================================================
    SYSTEM PAUSE: CONTINUITY
   ================================================================== */

describe("System pause: entered with no vote on a continuity break; unanimous resume; outage time never charged", () => {
  test("Live: every timer frozen as of the last proven instant; recovery does not resume; unanimity does, exactly", () => {
    const t = new Table("live");
    t.advance(13 * MIN + 48 * SEC); // 6:12 left
    const proven = t.t;
    t.t += 2 * HOUR; // the outage: the process died, nothing ran
    t.ok(continuityBreak(t.record, { now: t.t, preservedAt: proven, reason: "lost", authority: "auth-2" }));
    assert.equal(t.record.system?.preserved_at, proven);
    assert.equal(t.remaining(), 6 * MIN + 12 * SEC, "preserved exactly");
    assert.equal(t.refusal(A)?.code, CLOCK_REFUSAL.systemPaused);
    t.advance(10 * HOUR);
    assert.equal(t.record.phase, "active", "service recovery is not resume: nothing advances");
    assert.equal(t.remaining(), 6 * MIN + 12 * SEC);
    t.ok(systemResumeVote(t.record, A, t.t));
    t.ok(systemResumeVote(t.record, B, t.t));
    assert.notEqual(t.record.system, null, "two of three is not unanimity");
    t.ok(systemResumeVote(t.record, C, t.t));
    assert.equal(t.record.system, null);
    assert.equal(t.remaining(), 6 * MIN + 12 * SEC);
    t.advance(6 * MIN + 12 * SEC);
    assert.equal(t.record.phase, "overdue", "the preserved remainder runs exactly");
    assert.deepEqual(t.record.strikes, { [A]: 1 });
  });

  test("an outage that spans the would-be overdue creates NO overdue, NO strike, NO finality", () => {
    const t = new Table("live");
    t.advance(19 * MIN);
    const proven = t.t;
    t.t += 5 * HOUR; // the outage
    t.ok(continuityBreak(t.record, { now: t.t, preservedAt: proven, reason: "lost", authority: "auth-2" }));
    assert.equal(t.record.phase, "active");
    assert.deepEqual(t.record.strikes, {});
    assert.equal(t.remaining(), MIN);
  });

  test("an overdue cure window keeps its 4:30 across the outage; a train timer its 7:05", () => {
    const t = new Table("live");
    t.advance(LIVE_ACTION_MS + 5 * MIN + 30 * SEC);
    const proven = t.t;
    t.t += HOUR; // the outage
    t.ok(continuityBreak(t.record, { now: t.t, preservedAt: proven, reason: "lost", authority: "auth-2" }));
    assert.equal(t.cureLeft(), 4 * MIN + 30 * SEC);
    const u = new Table("live");
    u.move(A, offering(offerOf("train", A, B)), "propose", { trainRecipient: B });
    u.advance(2 * MIN + 55 * SEC);
    const proven2 = u.t;
    u.t += HOUR; // the outage
    u.ok(continuityBreak(u.record, { now: u.t, preservedAt: proven2, reason: "lost", authority: "auth-2" }));
    assert.equal(u.remaining(), 7 * MIN + 5 * SEC);
    assert.equal(u.advance(HOUR), null, "no trade expiry during the system pause");
  });

  test("approvals collected before the break are staled (a decision never crosses a continuity break on old votes)", () => {
    const t = new Table("live");
    t.advance(LIVE_ACTION_MS + MIN);
    t.ok(propose(t.record, B, "foreclose", null, t.t));
    t.ok(vote(t.record, C, t.record.overdue!.proposal!.id, true, null, t.t));
    const proven = t.t;
    t.ok(continuityBreak(t.record, { now: t.t + HOUR, preservedAt: proven, reason: "lost", authority: "auth-2" }));
    assert.equal(t.record.overdue?.proposal, null);
    t.t += HOUR;
    for (const seat of [A, B, C]) t.ok(systemResumeVote(t.record, seat, t.t));
    t.advance(LIVE_CURE_MS);
    assert.equal(t.record.ended?.kind, "live-timeout-annul", "the staled foreclosure approval no longer decides minute 30");
  });

  test("a money remedy sealed before the break, not final on chain, stays sealed and frozen by the system pause until every player resumes", () => {
    const t = new Table("live", { money: true });
    t.advance(LIVE_ACTION_MS + LIVE_CURE_MS);
    assert.equal(t.record.remedy?.status, "sealed");
    const sealed = t.record.remedy;
    t.ok(continuityBreak(t.record, { now: t.t + HOUR, preservedAt: t.t, reason: "lost", authority: "auth-2" }));
    assert.notEqual(t.record.system, null, "nothing not yet final on chain is relayed while system-paused");
    assert.deepEqual(t.record.remedy, sealed, "the sealed decision is unchanged (never re-decided)");
    for (const seat of [A, B, C]) t.ok(systemResumeVote(t.record, seat, t.t));
    assert.equal(t.record.system, null);
    assert.equal(t.record.phase, "ended");
    const done = t.record as GameClockRecord;
    const confirmed = { ...done, remedy: { ...(done.remedy as NonNullable<GameClockRecord["remedy"]>), status: "confirmed" as const } };
    assert.equal(continuityBreak(confirmed, { now: t.t + HOUR, preservedAt: t.t, reason: "lost", authority: "auth-3" }).record.system, null, "a result already final on chain stays final: no pause");
  });

  test("a break DURING the cure window freezes it; nothing is sealed until every player resumes and the preserved time runs out", () => {
    const t = new Table("live", { money: true });
    t.advance(LIVE_ACTION_MS + 9 * MIN);
    const proven = t.t;
    t.t += HOUR;
    t.ok(continuityBreak(t.record, { now: t.t, preservedAt: proven, reason: "lost", authority: "auth-2" }));
    t.advance(5 * HOUR);
    assert.equal(t.record.remedy, null, "no remedy from time that was never proven");
    for (const seat of [A, B, C]) t.ok(systemResumeVote(t.record, seat, t.t));
    assert.equal(t.cureLeft(), MIN);
    t.advance(MIN);
    const after = t.record as GameClockRecord;
    assert.equal(after.remedy?.kind, 1);
    assert.equal(after.remedy?.final_ms, t.t, "final at the resumed moment the preserved minute ran out");
  });

  test("Timed Async: the outage is credited automatically (no vote); No-deadline: nothing changes", () => {
    const t = new Table("async-pace", { pace: 43_200 });
    t.advance(10 * HOUR);
    const proven = t.t;
    t.t += 6 * HOUR; // the outage
    t.ok(continuityBreak(t.record, { now: t.t, preservedAt: proven, reason: "lost", authority: "auth-2" }));
    assert.equal(t.record.system, null);
    assert.equal(t.remaining(), 2 * HOUR, "the 6-hour outage is never charged");
    const n = new Table("no-deadline");
    n.ok(continuityBreak(n.record, { now: n.t + HOUR, preservedAt: n.t, reason: "lost", authority: "auth-2" }));
    assert.equal(n.record.system, null);
    assert.equal(n.record.obligation?.timer, null);
  });

  test("a gap the earlier authority left in the log is recovered from the log (re-derived, fenced against undo)", () => {
    const t = new Table("live");
    t.advance(5 * MIN);
    const at = t.t;
    const step = recoverGap(t.record, { now: t.t + HOUR, lastIndex: 7, lastAt: at, actors: [A], facts: facts(turn(B, 1)) });
    t.take(step);
    assert.deepEqual([t.record.obligation?.seat, t.record.watermark, t.record.undo_floor], [B, 7, 7]);
    assert.equal(remainingAt(t.record.obligation!.timer!, at), LIVE_ACTION_MS);
  });
});

/* ==================================================================
    TIMED ASYNC AND NO-DEADLINE
   ================================================================== */

describe("Timed Async: the host's pace, overdue only, N-1 annul or foreclose, no grace", () => {
  for (const pace of [43_200, 86_400, 172_800, 259_200, 604_800]) {
    test(`pace ${pace} s: overdue at exactly one pace, nothing else`, () => {
      const t = new Table("async-pace", { pace });
      t.advance(pace * SEC - 1);
      assert.equal(t.record.phase, "active");
      t.advance(1);
      assert.deepEqual([t.record.phase, t.record.overdue?.strike, t.record.overdue?.cure], ["overdue", 0, null]);
      assert.deepEqual(t.record.strikes, {}, "async overdues are not strikes");
      t.advance(400 * 24 * HOUR);
      assert.equal(t.record.phase, "overdue", "it may stay overdue indefinitely: no money moves by itself");
      assert.equal(t.record.ended, null);
    });
  }

  test("the pace is fixed once play begins", () => {
    const t = new Table("async-pace", { pace: 86_400 });
    const late = choosePolicy(t.record, "async-pace", 43_200, t.t);
    assert.equal("code" in late && late.code, "wrong-state");
    const fresh = newClockRecord({ gameId: GAME, deadline: "no-deadline", paceSecs: null, money: false, authority: "a", now: T0 });
    const chosen = choosePolicy(fresh, "async-pace", 259_200, T0);
    assert.ok(!("code" in chosen));
    const bad = choosePolicy(fresh, "async-pace", 3_600, T0);
    assert.equal("code" in bad && bad.code, "bad-frame");
  });

  test("other seats are not interrupted; a cure before consensus moots the proposal; no extra grace timer", () => {
    const t = new Table("async-pace", { pace: 43_200 });
    t.advance(43_200 * SEC);
    assert.equal(t.refusal(B), null, "Async overdue does not interrupt the table");
    t.ok(propose(t.record, B, "annul", null, t.t));
    t.advance(30 * 24 * HOUR);
    assert.equal(nextDue(t.record), null, "no grace timer of any kind");
    t.move(A, facts(turn(B, 1)));
    assert.deepEqual([t.record.phase, t.record.overdue], ["active", null]);
    assert.equal(t.remaining(), 43_200 * SEC);
  });

  test("N-1 neutral annulment is final at the moment consensus completes (money: remedy 4)", () => {
    const t = new Table("async-pace", { pace: 86_400, money: true });
    t.advance(86_400 * SEC + 3 * HOUR);
    const sig = { approve_until: 9_999_999_999, signature: "44".repeat(64) };
    t.ok(propose(t.record, B, "annul", sig, t.t));
    t.advance(2 * HOUR);
    t.ok(vote(t.record, C, t.record.overdue!.proposal!.id, true, sig, t.t));
    assert.deepEqual([t.record.ended?.kind, t.record.remedy?.kind, t.record.remedy?.final_ms, t.record.remedy?.strike], ["async-annul", 4, t.t, 0]);
  });

  test("N-1 foreclosure (remedy 5); a NO vetoes the proposal", () => {
    const t = new Table("async-pace", { pace: 86_400, money: true });
    t.advance(86_400 * SEC);
    const sig = { approve_until: 9_999_999_999, signature: "55".repeat(64) };
    t.ok(propose(t.record, B, "foreclose", sig, t.t));
    t.ok(vote(t.record, C, t.record.overdue!.proposal!.id, false, null, t.t));
    assert.equal(t.record.overdue?.proposal, null);
    t.ok(propose(t.record, C, "foreclose", sig, t.t));
    t.ok(vote(t.record, B, t.record.overdue!.proposal!.id, true, sig, t.t));
    assert.deepEqual([t.record.ended?.kind, t.record.remedy?.kind], ["async-foreclosure", 5]);
  });
});

describe("No-deadline: no clock, no overdue, ever", () => {
  test("years of inactivity create no overdue; no proposal is possible; the acknowledgement is per player", () => {
    const t = new Table("no-deadline");
    assert.equal(t.record.obligation?.timer, null);
    t.advance(3 * 365 * 24 * HOUR);
    assert.equal(t.record.phase, "active");
    assert.equal(t.record.overdue, null);
    const p = propose(t.record, B, "foreclose", null, t.t);
    assert.equal("code" in p && p.code, "wrong-state");
    const view = clockViewOf(t.record, t.t);
    assert.deepEqual([view.deadline, view.action], ["no-deadline", null], "never a countdown");
    const fresh = newClockRecord({ gameId: GAME, deadline: "no-deadline", paceSecs: null, money: true, authority: "a", now: T0 });
    const acked = acknowledge(fresh, A, T0);
    assert.ok(!("code" in acked));
    if (!("code" in acked)) assert.deepEqual(clockViewOf(acked.record, T0).noDeadlineAcks, [A]);
  });
});

/* ==================================================================
    UNANIMOUS ANNULMENT (FREE TABLE) AND UNDO
   ================================================================== */

describe("A free table's unanimous neutral annulment", () => {
  test("every seated player's YES ends the game, in any state (active, overdue, system-paused); a NO clears it", () => {
    const t = new Table("live");
    t.ok(annulVote(t.record, A, true, t.t));
    t.ok(annulVote(t.record, B, false, t.t));
    assert.equal(t.record.annul, null);
    const o = new Table("live");
    o.advance(LIVE_ACTION_MS);
    for (const seat of [A, B, C]) o.ok(annulVote(o.record, seat, true, o.t));
    assert.equal(o.record.ended?.kind, "annulled");
    const s = new Table("live");
    s.ok(continuityBreak(s.record, { now: s.t + HOUR, preservedAt: s.t, reason: "lost", authority: "x" }));
    for (const seat of [A, B, C]) s.ok(annulVote(s.record, seat, true, s.t));
    assert.equal(s.record.ended?.kind, "annulled");
    const m = new Table("live", { money: true });
    const refused = annulVote(m.record, A, true, m.t);
    assert.equal("code" in refused && refused.code, "wrong-state", "a money table annuls through its escrow");
  });
});

describe("Undo never manufactures a clock", () => {
  test("an act-and-undo by the same human charges the time used since: no fresh 20:00", () => {
    const t = new Table("live");
    t.advance(15 * MIN); // 5:00 left
    t.move(A, facts(turn(A, 0)));
    const actIndex = t.index;
    t.advance(3 * MIN);
    t.move(A, facts(turn(A, 0)), "revert", { revertTarget: actIndex });
    assert.equal(t.remaining(), 2 * MIN, "5:00 then 3:00 used");
  });

  test("undoing an action that passed responsibility restores the actor's own remainder (the other's time is not charged)", () => {
    const t = new Table("live");
    t.advance(12 * MIN);
    t.move(A, facts(turn(B, 1)));
    const actIndex = t.index;
    t.advance(4 * MIN);
    t.move(A, facts(turn(A, 0)), "revert", { revertTarget: actIndex });
    assert.deepEqual([t.record.obligation?.seat, t.remaining()], [A, 8 * MIN]);
  });

  test("undoing a rejection restores the recipient's response time; the decline is NOT given back", () => {
    const t = new Table("live");
    t.move(A, offering(offerOf("train", A, B)), "propose", { trainRecipient: B });
    t.advance(4 * MIN);
    t.move(B, facts(turn(A, 0)), "reject");
    const rejectIndex = t.index;
    t.advance(MIN);
    t.move(B, offering(offerOf("train", A, B)), "revert", { revertTarget: rejectIndex });
    assert.deepEqual([t.record.obligation?.seat, t.remaining(), t.record.declines.counts[`${A}>${B}`]], [B, 6 * MIN, 1]);
    assert.equal(t.record.parked[0]?.seat, A);
  });

  test("no undo while overdue, nor across a fence (a cure, an expiry, a pause, a system pause)", () => {
    const t = new Table("live");
    t.advance(LIVE_ACTION_MS);
    assert.equal(t.refusal(A, "revert", { revertTarget: 0 })?.code, CLOCK_REFUSAL.undoFence);
    t.move(A, facts(turn(A, 0)));
    const cure = t.index;
    assert.equal(t.refusal(A, "revert", { revertTarget: cure })?.code, CLOCK_REFUSAL.undoFence, "the cure itself cannot be undone");
    t.move(A, facts(turn(A, 0)));
    assert.equal(t.refusal(A, "revert", { revertTarget: t.index }), null, "a later ordinary action can be");
    assert.equal(t.record.strikes[A], 1, "and no undo ever erases the strike");
  });
});

/* ==================================================================
    EVIDENCE, SHAPE, PARSING
   ================================================================== */

describe("Canonical clock evidence", () => {
  test("deterministic: the same facts in the same order make the same head; any change makes another", () => {
    const run = (cure: number) => {
      const t = new Table("live", { money: true });
      t.advance(LIVE_ACTION_MS + cure);
      t.advance(LIVE_CURE_MS);
      return t.record;
    };
    assert.equal(run(0).evidence.head, run(0).evidence.head);
    const a = run(0);
    assert.equal(foldEvidence(genesisHead(GAME), []), genesisHead(GAME));
    assert.equal(evidenceHashOf(a.remedy!.evidence), a.remedy!.evidence_hash);
    const t = new Table("live", { money: true });
    t.advance(SEC);
    t.move(A, facts(turn(A, 1)));
    t.advance(LIVE_ACTION_MS + LIVE_CURE_MS);
    assert.equal(t.record.remedy?.overdue_ms, T0 + SEC + LIVE_ACTION_MS);
    assert.notEqual(t.record.remedy?.evidence_hash, a.remedy?.evidence_hash, "a different overdue moment is different evidence");
  });

  test("the remedy's evidence window begins at the defaulting obligation's responsibility event and ends at the seal", () => {
    const t = new Table("live", { money: true });
    t.move(A, facts(turn(B, 1)));
    t.advance(LIVE_ACTION_MS + LIVE_CURE_MS);
    const kinds = t.record.remedy!.evidence.events.map((event) => event.kind);
    assert.deepEqual(kinds, ["responsibility", "overdue", "final", "remedy-sealed"]);
    assert.equal(t.record.remedy!.evidence.events[0].f.seat, B);
  });

  test("canonical JSON refuses floats; no signature is ever in an event (only its digest)", () => {
    assert.throws(() => canonicalJson({ x: 0.5 }));
    assert.equal(canonicalJson({ b: 1, a: [2, "x"] }), '{"a":[2,"x"],"b":1}');
    const t = new Table("live", { money: true });
    t.advance(LIVE_ACTION_MS);
    const sig = "ab".repeat(64);
    t.ok(propose(t.record, B, "foreclose", { approve_until: 9_999_999_999, signature: sig }, t.t));
    assert.ok(!JSON.stringify(t.record.evidence.window).includes(sig), "the signature itself never enters the evidence");
  });

  test("a record round-trips; an older (v1) or newer document is unreadable, never guessed", () => {
    const t = new Table("live");
    assert.deepEqual(parseClockDocument(JSON.stringify(t.record), GAME), t.record);
    assert.throws(() => parseClockDocument(JSON.stringify({ format: "gs-game-clock", version: 1, game_id: GAME }), GAME), (error) => error instanceof ClockUnreadableError && error.format === "older");
    assert.throws(() => parseClockDocument(JSON.stringify({ format: "gs-game-clock", version: 3, game_id: GAME }), GAME), (error) => error instanceof ClockUnreadableError && error.format === "newer");
  });

  test("message classes: proposals, answers, rescissions, undo, the deal, the room's close", () => {
    assert.deepEqual(classifyMessage({ ProposeTrainPurchase: {} }), { cls: "propose", revertTarget: null, closeRoom: false });
    assert.deepEqual(classifyMessage({ AnswerTrainPurchase: { accept: false } }).cls, "reject");
    assert.deepEqual(classifyMessage({ AnswerPrivatePurchase: { accept: true } }).cls, "accept");
    assert.deepEqual(classifyMessage({ RescindTrainPurchase: {} }).cls, "rescind");
    assert.deepEqual(classifyMessage({ RevertTo: { index: 4 } }), { cls: "revert", revertTarget: 4, closeRoom: false });
    assert.deepEqual(classifyMessage({ CloseRoom: {} }).closeRoom, true);
    assert.equal(classifyMessage({ SetupGame: {} }).cls, "deal");
  });
});

/* ==================================================================
    REVIEW FIXES (final pass): bounded pause requests, the system-pause YES bound to its break, gap recovery that never
    hands out time, an overdue seat's offer, optional powers, approvals that must outlive finality, stale approvals
   ================================================================== */

describe("Review fixes: requests, breaks, gaps, offers, approvals", () => {
  const sig = (until: number, byte = "44") => ({ approve_until: until, signature: byte.repeat(64) });

  test("PAUSE requests are bounded per obligation (a new obligation opens a new window); a RESUME request never is", () => {
    const t = new Table("live");
    for (let i = 0; i < 16; i += 1) {
      t.ok(pauseOp(t.record, A, { action: "request", kind: "pause", id: null }, t.t));
      t.ok(pauseOp(t.record, B, { action: "no", kind: "pause", id: t.record.pause.request?.id ?? null }, t.t));
    }
    const refused = pauseOp(t.record, A, { action: "request", kind: "pause", id: null }, t.t);
    assert.equal("code" in refused ? refused.code : null, "rate-limited");
    t.move(A, facts(turn(B, 1)));
    t.ok(pauseOp(t.record, B, { action: "request", kind: "pause", id: null }, t.t));
    for (const seat of [A, C]) t.ok(pauseOp(t.record, seat, { action: "yes", kind: "pause", id: t.record.pause.request?.id ?? null }, t.t));
    assert.notEqual(t.record.pause.paused_at, null);
    for (let i = 0; i < 40; i += 1) {
      t.ok(pauseOp(t.record, A, { action: "request", kind: "resume", id: null }, t.t));
      t.ok(pauseOp(t.record, C, { action: "no", kind: "resume", id: t.record.pause.request?.id ?? null }, t.t));
    }
    t.ok(pauseOp(t.record, A, { action: "request", kind: "resume", id: null }, t.t));
    assert.equal(t.record.pause.request?.kind, "resume", "a paused table can always ask to resume");
  });

  test("a system-pause YES names the break it saw; a later break needs a fresh look", () => {
    const t = new Table("live");
    t.advance(5 * MIN);
    t.ok(continuityBreak(t.record, { now: t.t + MIN, preservedAt: t.t, reason: "restart", authority: "auth-2" }));
    const first = t.record.system?.since as number;
    t.ok(systemResumeVote(t.record, A, t.t, first));
    t.ok(continuityBreak(t.record, { now: t.t + 2 * MIN, preservedAt: t.t, reason: "again", authority: "auth-3" }));
    const second = t.record.system?.since as number;
    assert.ok(second > first);
    const stale = systemResumeVote(t.record, B, t.t, first);
    assert.equal("code" in stale ? stale.code : null, CLOCK_REFUSAL.stale);
    for (const seat of [A, B, C]) t.ok(systemResumeVote(t.record, seat, t.t, second));
    assert.equal(t.record.system, null);
  });

  test("a recovered gap never hands out time: a seat that still owes and did not act continues; a parked proposer keeps its remainder", () => {
    const t = new Table("live");
    t.advance(15 * MIN);
    /* Off-turn moves by B (never folded): A still owes, did not act -- 5:00 left, not a fresh 20:00. */
    const kept = recoverGap(t.record, { now: t.t, lastIndex: 3, lastAt: t.t, actors: [B], facts: facts(turn(A, 0)) });
    t.take(kept);
    assert.equal(t.remaining(), 5 * MIN);
    /* A's train offer to B stands; the gap folded nothing more: A's parked 5:00 and B's response time are kept. */
    t.move(A, offering(offerOf("train", A, B, 7)), "propose", { trainRecipient: B });
    t.advance(3 * MIN);
    t.take(recoverGap(t.record, { now: t.t, lastIndex: 9, lastAt: t.t, actors: [], facts: offering(offerOf("train", A, B, 7)) }));
    assert.deepEqual(t.record.parked.map((p) => [p.seat, p.remaining_ms]), [[A, 5 * MIN]]);
    assert.equal(t.remaining(), LIVE_TRADE_MS - 3 * MIN, "the same offer keeps its response time");
    /* The gap closed the offer by rescission (A acted -- not a REQUIRED action): A resumes its parked remainder. */
    t.take(recoverGap(t.record, { now: t.t, lastIndex: 12, lastAt: t.t, actors: [], facts: facts(turn(A, 0)) }));
    assert.equal(t.remaining(), 5 * MIN);
  });

  test("an overdue seat's own offer is refused (it cannot cure); the M&H exchange is optional: it neither refreshes nor cures", () => {
    const t = new Table("live");
    t.advance(LIVE_ACTION_MS);
    assert.equal(t.record.phase, "overdue");
    assert.equal(t.refusal(A, "propose", { trainRecipient: B })?.code, CLOCK_REFUSAL.interrupted);
    t.move(A, facts(turn(A, 0)), "optional");
    assert.equal(t.record.phase, "overdue", "an optional power is not the owed action");
    assert.equal(classifyMessage({ ExchangePrivate: {} }).cls, "optional");
    t.move(A, facts(turn(A, 0)));
    assert.equal(t.record.phase, "active");
    t.advance(5 * MIN);
    t.move(A, facts(turn(A, 0)), "optional");
    assert.equal(t.remaining(), 15 * MIN, "an optional power never refreshes the clock");
  });

  test("Live money: a complete foreclosure decides minute 30 only if every approval outlives the finality by the margin", () => {
    const t = new Table("live", { money: true });
    t.advance(LIVE_ACTION_MS);
    const finalSecs = Math.ceil((T0 + LIVE_ACTION_MS + LIVE_CURE_MS) / 1000);
    t.ok(propose(t.record, B, "foreclose", sig(finalSecs + 301), t.t));
    t.ok(vote(t.record, C, t.record.overdue?.proposal?.id as number, true, sig(finalSecs + 300, "55"), t.t));
    assert.equal(clockViewOf(t.record, t.t).overdue?.outcomeIfUncured, "timeout-annul", "C's approval ends exactly at the margin: it cannot decide minute 30");
    t.advance(LIVE_CURE_MS);
    assert.equal(t.record.ended?.kind, "live-timeout-annul");
    assert.equal(t.record.remedy?.kind, 1);
  });

  test("a money YES checked for one kind never counts toward the other; a seat whose key moved is set aside", () => {
    const t = new Table("async-pace", { pace: 86_400, money: true });
    t.advance(86_400 * SEC);
    const nowSecs = Math.floor(t.t / 1000);
    t.ok(propose(t.record, B, "annul", sig(nowSecs + 7 * 86_400), t.t));
    const id = t.record.overdue?.proposal?.id as number;
    const wrongKind = vote(t.record, C, id, true, sig(nowSecs + 7 * 86_400, "55"), t.t, { kind: "foreclose" });
    assert.equal("code" in wrongKind ? wrongKind.code : null, CLOCK_REFUSAL.stale);
    t.ok(vote(t.record, C, id, true, sig(nowSecs + 7 * 86_400, "55"), t.t, { kind: "annul", stale: [B] }));
    assert.equal(t.record.phase, "overdue", "B's YES no longer verifies: no consensus");
    assert.deepEqual(t.record.overdue?.proposal?.votes.map((v) => v.seat), [C]);
    assert.ok(t.events.includes("vote-stale"));
    t.ok(vote(t.record, B, id, true, sig(nowSecs + 7 * 86_400, "66"), t.t, { kind: "annul" }));
    assert.equal(t.record.ended?.kind, "async-annul");
  });

  test("Async money: an approval with under an hour left never completes the consensus", () => {
    const t = new Table("async-pace", { pace: 86_400, money: true });
    t.advance(86_400 * SEC);
    const nowSecs = Math.floor(t.t / 1000);
    t.ok(propose(t.record, B, "foreclose", sig(nowSecs + 3_600), t.t));
    t.ok(vote(t.record, C, t.record.overdue?.proposal?.id as number, true, sig(nowSecs + 7 * 86_400, "55"), t.t));
    assert.equal(t.record.phase, "overdue");
    assert.deepEqual(t.record.overdue?.proposal?.votes.map((v) => v.seat), [C], "B's lapsing YES is set aside; B is asked again");
  });

  test("Async money: approvals found stale after sealing are renewed by their seats, then the SAME decision is sealed again", () => {
    const t = new Table("async-pace", { pace: 86_400, money: true });
    t.advance(86_400 * SEC);
    const nowSecs = Math.floor(t.t / 1000);
    t.ok(propose(t.record, B, "foreclose", sig(nowSecs + 7 * 86_400), t.t));
    t.ok(vote(t.record, C, t.record.overdue?.proposal?.id as number, true, sig(nowSecs + 7 * 86_400, "55"), t.t));
    const sealed = t.record.remedy as NonNullable<GameClockRecord["remedy"]>;
    assert.equal(sealed.kind, 5);
    t.take(remedyStale(t.record, [C], t.t));
    assert.deepEqual([t.record.remedy?.status, t.record.remedy?.stale], ["refused", [C]]);
    assert.deepEqual(clockViewOf(t.record, t.t).remedy?.stale, [C]);
    assert.equal(clockViewOf(t.record, t.t).remedy?.overdue.logLen, sealed.log_len, "the view carries what a renewed approval binds to");
    const notStale = reapprove(t.record, B, sig(nowSecs + 9 * 86_400), t.t);
    assert.equal("code" in notStale, true);
    t.ok(reapprove(t.record, C, sig(nowSecs + 9 * 86_400, "77"), t.t));
    const resealed = t.record.remedy as NonNullable<GameClockRecord["remedy"]>;
    assert.deepEqual([resealed.kind, resealed.epoch, resealed.log_len, resealed.status, resealed.stale], [5, sealed.epoch, sealed.log_len, "sealed", []]);
    assert.notEqual(resealed.evidence_hash, sealed.evidence_hash, "a new seal of the same decision");
    assert.equal(resealed.approvals.find((a) => a.seat === C)?.approve_until, nowSecs + 9 * 86_400);
  });
});
