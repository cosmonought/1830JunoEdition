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
import { canonicalJson, evidenceHashOf, foldEvidence, genesisHead, ledgerGenesisHead, ledgerHeadOf } from "./clockEvidence";
import {
  acknowledge,
  advance,
  annulVote,
  choosePolicy,
  classifyMessage,
  clockViewOf,
  continuityBreak,
  FINALITY_KEYS_UNREAD,
  finalityKeyCheckDue,
  foldBatch,
  gate,
  newClockRecord,
  nextDue,
  pauseOp,
  propose,
  recoverGap,
  remainingAt,
  remedyBlocked,
  remedyProgress,
  systemResumeVote,
  vote,
  type ClockBoardFacts,
  type ClockMsgClass,
  type ClockStep,
} from "./clockModel";
import { CLOCK_EVIDENCE_WINDOW, isGameClockRecord, LIVE_ACTION_MS, LIVE_CURE_MS, LIVE_TRADE_MS, parseClockDocument, ClockUnreadableError, type GameClockRecord } from "./clockRecord";
import { sealedRemedyProblem } from "../../escrow/remedyPipeline";

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
  return { over: false, closed: false, seats: [A, B, C], decision, offer: null, roundKey: "OperatingRound/1/1", ...over };
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
    assert.deepEqual(t.record.parked, [{ seat: A, offer_key: offer.key, remaining_ms: 13 * MIN + 48 * SEC, key: turn(A).key }]);
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

  test("accept: the trade resolves; the proposer, still owing its turn, resumes its EXACT remainder -- an accepted optional offer never manufactures time", () => {
    const t = new Table("live");
    t.advance(15 * MIN);
    t.move(A, offering(offer), "propose", { trainRecipient: B });
    t.advance(3 * MIN);
    t.move(B, facts(turn(A, 0)), "accept");
    assert.equal(t.record.obligation?.seat, A);
    assert.equal(t.remaining(), 5 * MIN, "the 5:00 A had when it proposed (never a fresh 20:00)");
    assert.equal(t.record.declines.counts[`${A}>${B}`] ?? 0, 0, "an acceptance is no decline");
    assert.deepEqual(t.record.parked, []);
    /* A genuine handoff after it (A's own required move passing responsibility) gives the next seat a fresh 20:00. */
    t.move(A, facts(turn(B, 1)));
    assert.deepEqual([t.record.obligation?.seat, t.remaining()], [B, LIVE_ACTION_MS]);
  });

  test("explicit rejection counts one decline, and A resumes EXACTLY what it had (an offer never refreshes its proposer: no offer-and-reject stall)", () => {
    const t = new Table("live");
    t.advance(15 * MIN);
    t.move(A, offering(offer), "propose", { trainRecipient: B });
    t.advance(3 * MIN);
    t.move(B, facts(turn(A, 0)), "reject");
    assert.equal(t.record.declines.counts[`${A}>${B}`], 1);
    assert.equal(t.remaining(), 5 * MIN, "the 5:00 A had when it proposed");
    /* An ACCEPTED offer does not refresh either: A still owes its turn. */
    t.move(A, offering(offerOf("train", A, C, 2)), "propose", { trainRecipient: C });
    t.advance(MIN);
    t.move(C, facts(turn(A, 0)), "accept");
    assert.equal(t.remaining(), 5 * MIN);
  });

  test("LIVE: a qualifying NON-train inter-player offer gets the same 10:00 response treatment; the proposer resumes its exact remainder; the decline joins the one directional counter", () => {
    const t = new Table("live");
    t.advance(19 * MIN + 50 * SEC);
    const priv = offerOf("private", A, B, 9);
    t.move(A, offering(priv), "propose");
    assert.deepEqual([t.record.obligation?.seat, t.record.obligation?.trade?.proposer, t.remaining()], [B, A, LIVE_TRADE_MS], "B's distinct 10:00 response timer");
    assert.deepEqual(t.record.parked, [{ seat: A, offer_key: priv.key, remaining_ms: 10 * SEC, key: turn(A).key }], "A frozen at its exact remainder");
    assert.equal(clockViewOf(t.record, t.t).trade?.kind, "private");
    t.advance(4 * MIN);
    t.move(B, facts(turn(A, 0)), "reject");
    assert.equal(t.remaining(), 10 * SEC, "A resumes exactly: never fresh, never charged for B's time");
    assert.equal(t.record.declines.counts[`${A}>${B}`], 1, "one decline A -> B (one counter per direction, whatever the kind)");
    /* A confederate sitting on the offer: at most 10:00, then it expires (no strike for anyone), one more decline. */
    const sat = new Table("live");
    sat.advance(5 * MIN);
    sat.move(A, offering(offerOf("trade", A, B, 10)), "propose");
    const expiry = sat.advance(LIVE_TRADE_MS);
    assert.notEqual(expiry, null, "the response time ran out");
    sat.commit(A, facts(turn(A, 0)), "server-expiry");
    assert.deepEqual([sat.remaining(), sat.record.strikes, sat.record.declines.counts[`${A}>${B}`]], [15 * MIN, {}, 1]);
  });

  test("LIVE: two declines A -> B (mixed kinds) block a third QUALIFYING A -> B offer in that round instance (operating sub-round 1.1); B -> A and A -> C stay open; the next operating sub-round (1.2) clears it", () => {
    const t = new Table("live");
    t.move(A, offering(offerOf("private", A, B, 1)), "propose");
    t.move(B, facts(turn(A, 0)), "reject");
    t.move(A, offering(offerOf("train", A, B, 2)), "propose", { trainRecipient: B });
    t.advance(LIVE_TRADE_MS);
    t.commit(A, facts(turn(A, 0)), "server-expiry");
    assert.equal(t.record.declines.counts[`${A}>${B}`], 2);
    /* The pre-speculation train check (the board's own answerer is re-checked after speculation: clockController). */
    assert.equal(t.refusal(A, "propose", { trainRecipient: B })?.code, CLOCK_REFUSAL.declines);
    assert.equal(t.refusal(A, "propose", { trainRecipient: C }), null, "another player stays open");
    assert.equal(clockViewOf(t.record, t.t).declines.find((d) => d.from === A && d.to === B)?.count, 2);
    /* The reverse direction is its own counter. */
    t.move(A, facts(turn(B, 1)));
    t.move(B, offering(offerOf("private", B, A, 3)), "propose");
    assert.equal(t.record.obligation?.trade?.proposer, B, "B -> A is a qualifying offer of its own");
    t.move(A, facts(turn(B, 1)), "reject");
    assert.deepEqual([t.record.declines.counts[`${B}>${A}`], t.record.declines.counts[`${A}>${B}`]], [1, 2]);
    /* The next operating sub-round (a new round instance) clears every count. */
    t.move(B, facts(turn(A, 2), { roundKey: "OperatingRound/1/2" }));
    assert.deepEqual(t.record.declines, { round_key: "OperatingRound/1/2", counts: {}, offers: [] });
    assert.equal(t.refusal(A, "propose", { trainRecipient: B }), null);
  });

  test("LIVE: a genuine counter / continuation of the negotiation is not a decline; an accept or a rescission is none either", () => {
    const t = new Table("live");
    const first = offerOf("trade", A, B, 1);
    t.move(A, offering(first), "propose");
    /* B answers with an offer of its own that replaces A's (a continuation): no offer was declined. */
    t.move(B, offering(offerOf("trade", B, A, 2)), "propose");
    assert.equal(t.record.declines.counts[`${A}>${B}`] ?? 0, 0, "a counter is no decline");
    t.move(A, facts(turn(A, 0)), "accept");
    assert.deepEqual(t.record.declines.counts, {}, "an acceptance is no decline");
    t.move(A, offering(offerOf("private", A, B, 3)), "propose");
    t.move(A, facts(turn(A, 0)), "rescind");
    assert.deepEqual(t.record.declines.counts, {}, "the proposer's own rescission is no decline");
  });

  test("LIVE: an offer that suspends nothing of its proposer's (an off-turn proposer) gets no response timer and counts no decline", () => {
    const t = new Table("live");
    t.advance(5 * MIN);
    /* C is not the responsible seat (A is): C's offer to B puts the answer on B as an ordinary required decision. */
    t.move(C, offering(offerOf("trade", C, B, 4)), "propose");
    assert.equal(t.record.obligation?.seat, B);
    assert.equal(t.record.obligation?.trade, null, "no 10:00 response timer: the ordinary action clock");
    assert.equal(t.remaining(), LIVE_ACTION_MS);
    assert.deepEqual(t.record.parked, [{ seat: A, offer_key: "trade:4", remaining_ms: 15 * MIN, key: turn(A).key }], "the RESPONSIBLE seat's clock (A's) is suspended meanwhile: frozen exactly");
    t.advance(2 * MIN);
    t.move(B, facts(turn(A, 0)), "reject");
    assert.deepEqual(t.record.declines.counts, {}, "no decline for an offer that never suspended its proposer");
    assert.deepEqual([t.record.obligation?.seat, t.remaining()], [A, 15 * MIN], "A resumes exactly: nobody's negotiation manufactures A time");
  });

  test("REVIEW: an offer whose board key repeats (a funding offer has no instance) still counts each declined PROPOSAL -- a third is refused; an answer undone and given again is still one decline", () => {
    const t = new Table("live");
    const funding = offerOf("funding", A, B, 5); // the same key every time
    t.move(A, offering(funding), "propose");
    t.move(B, facts(turn(A, 0)), "reject");
    t.move(A, offering(funding), "propose");
    t.advance(LIVE_TRADE_MS);
    t.commit(A, facts(turn(A, 0)), "server-expiry");
    assert.equal(t.record.declines.counts[`${A}>${B}`], 2, "two proposals, two declines (never folded into one by their key)");
    /* Undo of a rejection, then the same rejection again: the proposal is the same, the decline counted once. */
    const u = new Table("live");
    u.move(A, offering(offerOf("private", A, B, 7)), "propose");
    const proposalIndex = u.index;
    u.move(B, facts(turn(A, 0)), "reject");
    assert.equal(u.record.declines.counts[`${A}>${B}`], 1);
    u.move(B, offering(offerOf("private", A, B, 7)), "revert", { revertTarget: u.index });
    assert.equal(u.record.obligation?.began_index, proposalIndex, "the answerer's response restored");
    u.move(B, facts(turn(A, 0)), "reject");
    assert.equal(u.record.declines.counts[`${A}>${B}`], 1, "the same proposal is declined once");
  });

  test("REVIEW: a recovered gap with a standing QUALIFYING non-train Live offer keeps the answerer on the 10:00 response timer (never an action clock or a strike)", () => {
    const t = new Table("live");
    t.advance(5 * MIN);
    const priv = offerOf("private", A, B, 3);
    /* The offer was committed by an authority whose clock write never landed: the record still shows A responsible. */
    t.take(recoverGap(t.record, { now: t.t + MIN, lastIndex: 3, lastAt: t.t, actors: [A], facts: offering(priv) }));
    assert.deepEqual([t.record.obligation?.seat, t.record.obligation?.trade?.proposer, t.remaining()], [B, A, LIVE_TRADE_MS]);
    assert.deepEqual(t.record.parked.map((p) => [p.seat, p.remaining_ms]), [[A, 15 * MIN]]);
    const expiry = t.advance(LIVE_TRADE_MS);
    assert.notEqual(expiry, null, "it expires as an offer, never as an overdue");
    assert.deepEqual([t.record.phase, t.record.strikes], ["active", {}]);
  });

  test("LAST CORRECTION: a counter / continuation never manufactures time -- the original proposer resumes its exact remainder however the chain ends", () => {
    for (const ending of ["accept", "reject"] as const) {
      const t = new Table("live");
      t.advance(15 * MIN); // A has 5:00
      t.move(A, offering(offerOf("trade", A, B, 1)), "propose");
      t.advance(2 * MIN);
      /* B continues the negotiation with an offer of its own that replaces A's: A's park carries over. */
      t.move(B, offering(offerOf("trade", B, A, 2)), "propose");
      assert.deepEqual(t.record.declines.counts, {}, "a counter is no decline");
      assert.ok(t.record.parked.some((p) => p.seat === A && p.remaining_ms === 5 * MIN), "A still parked at exactly 5:00");
      t.advance(MIN);
      t.move(A, facts(turn(A, 0)), ending);
      assert.deepEqual([t.record.obligation?.seat, t.remaining()], [A, 5 * MIN], `${ending}: A resumes exactly 5:00 (never fresh)`);
    }
  });

  test("LAST CORRECTION (Async): an optional offer never resets, nor stops, the action deadline -- the proposer's park keeps RUNNING, so accepted, rejected or countered it resumes its deadline as it stands; colluding trades cannot keep it alive; a required action and a genuine handoff do refresh", () => {
    const t = new Table("async-pace", { pace: 86_400 });
    t.advance(20 * HOUR); // A has 4 h
    t.move(A, offering(offerOf("private", A, B, 1)), "propose");
    assert.deepEqual(t.record.parked.map((p) => [p.seat, p.remaining_ms, p.since]), [[A, 4 * HOUR, t.t]], "A's 4 hours are parked RUNNING");
    assert.deepEqual(clockViewOf(t.record, t.t + 10 * MIN).running, [{ seat: A, remainingMs: 4 * HOUR - 10 * MIN }], "every tab is shown A's deadline still running");
    assert.equal(t.remaining(), 86_400 * SEC, "B owes its answer on an ordinary pace");
    t.advance(HOUR);
    t.move(B, facts(turn(A, 0)), "accept");
    assert.deepEqual([t.record.obligation?.seat, t.remaining()], [A, 3 * HOUR], "accepted: A resumes its deadline as it stands (the hour B took is A's)");
    /* Collusion: A offers, B waits, B answers -- again and again. A's deadline only ever runs down. */
    for (let n = 2; n <= 6; n += 1) {
      t.move(A, offering(offerOf("private", A, B, n)), "propose");
      t.advance(30 * MIN);
      t.move(B, facts(turn(A, 0)), n % 2 === 0 ? "accept" : "reject");
    }
    assert.equal(t.remaining(), 30 * MIN, "five half-hour trades cost A two and a half hours: colluding trades keep nobody's deadline alive");
    /* A counter does not stop it either: B's counter-offer, A's answer, all on A's deadline. */
    t.move(A, offering(offerOf("private", A, B, 7)), "propose");
    t.advance(10 * MIN);
    t.move(B, offering(offerOf("private", B, A, 8)), "propose");
    assert.equal(t.record.obligation?.seat, A, "A owes the answer to the counter");
    t.advance(10 * MIN);
    t.move(A, facts(turn(A, 0)), "reject");
    assert.deepEqual([t.record.obligation?.seat, t.remaining()], [A, 10 * MIN], "the counter chain ran on A's deadline");
    /* Offers past the deadline: the park reaches zero while B holds it; A resumes nothing and is overdue at once. */
    t.move(A, offering(offerOf("private", A, B, 9)), "propose");
    t.advance(20 * HOUR);
    t.move(B, facts(turn(A, 0)), "accept");
    assert.equal(t.remaining(), 0);
    t.advance(0);
    assert.deepEqual([t.record.phase, t.record.overdue?.seat], ["overdue", A], "the deadline passed during the negotiation: A is overdue when it resumes");
    /* A required action (its cure) refreshes; a genuine handoff gives the next seat its fresh pace. */
    t.move(A, facts(turn(A, 1)));
    assert.equal(t.remaining(), 86_400 * SEC);
    t.move(A, facts(turn(B, 2)));
    assert.deepEqual([t.record.obligation?.seat, t.remaining()], [B, 86_400 * SEC]);
  });

  test("REVIEW (Async): a running park is credited a restart's outage exactly like the running clock, and restored as it stands by an undo", () => {
    const t = new Table("async-pace", { pace: 86_400 });
    t.advance(20 * HOUR);
    t.move(A, offering(offerOf("private", A, B, 1)), "propose");
    t.advance(HOUR);
    /* The server is gone for 5 hours (from the last proof at +1h): the outage is credited to the parked deadline too. */
    const preserved = t.t;
    t.t += 5 * HOUR;
    t.take(continuityBreak(t.record, { now: t.t, preservedAt: preserved, reason: "restart", authority: "auth-2" }));
    assert.deepEqual(t.record.parked.map((p) => [p.remaining_ms, p.since]), [[3 * HOUR, t.t]], "credited: 3 hours, running from now");
    t.advance(HOUR);
    t.move(B, facts(turn(A, 0)), "reject");
    assert.equal(t.remaining(), 2 * HOUR);
    /* Parse round trip: a running park is a valid stored record; a Live park carries no \`since\`. */
    assert.deepEqual(parseClockDocument(JSON.stringify(t.record), GAME).parked, t.record.parked);
    const live = new Table("live");
    live.move(A, offering(offerOf("trade", A, B, 1)), "propose");
    assert.equal("since" in (live.record.parked[0] ?? {}), false, "a Live park is frozen (no since)");
  });

  test("LAST CORRECTION (round instance): two declines in OR 2.1 block a third A -> B there; OR 2.2 starts at zero; a Stock Round's count resets at the next Stock Round even when the empty ORs between pass inside one batch", () => {
    const or21 = "OperatingRound/2/1";
    const t = new Table("live");
    t.move(A, facts(turn(A, 0), { roundKey: or21 }));
    for (let n = 1; n <= 2; n += 1) {
      t.move(A, offering(offerOf("train", A, B, n), { roundKey: or21 }), "propose", { trainRecipient: B });
      t.move(B, facts(turn(A, 0), { roundKey: or21 }), "reject");
    }
    assert.deepEqual([t.record.declines.round_key, t.record.declines.counts[`${A}>${B}`]], [or21, 2]);
    assert.equal(t.refusal(A, "propose", { trainRecipient: B })?.code, CLOCK_REFUSAL.declines, "OR 2.1: the third A -> B is refused");
    t.move(A, facts(turn(B, 1), { roundKey: "OperatingRound/2/2" }));
    assert.deepEqual(t.record.declines, { round_key: "OperatingRound/2/2", counts: {}, offers: [] }, "OR 2.2 starts with zero A -> B declines");
    assert.equal(t.refusal(A, "propose", { trainRecipient: B }), null);
    /* Stock Round instances: SR 3's declines never leak into SR 4, even across a batch that passes the empty ORs. */
    const sr = new Table("live");
    sr.move(A, facts(turn(A, 0), { roundKey: "StockRound/3/0" }));
    for (let n = 1; n <= 2; n += 1) {
      sr.move(A, offering(offerOf("trade", A, B, n), { roundKey: "StockRound/3/0" }), "propose");
      sr.move(B, facts(turn(A, 0), { roundKey: "StockRound/3/0" }), "reject");
    }
    assert.equal(sr.record.declines.counts[`${A}>${B}`], 2);
    sr.move(A, facts(turn(B, 1), { roundKey: "StockRound/4/0" }));
    assert.deepEqual(sr.record.declines, { round_key: "StockRound/4/0", counts: {}, offers: [] }, "the next Stock Round resets it");
  });

  test("NO 16-OFFER CAP: well over 16 otherwise-legal offers in one round are each taken (Live and Async); no game-rule refusal exists", () => {
    const live = new Table("live");
    for (let n = 1; n <= 40; n += 1) {
      assert.equal(live.refusal(A, "propose"), null, `offer ${n} is legal`);
      live.move(A, offering(offerOf("private", A, B, 100 + n)), "propose");
      live.move(A, facts(turn(A, 0)), "rescind");
    }
    /* Alternating answerers with acceptances: still no limit of any kind. */
    for (let n = 1; n <= 20; n += 1) {
      live.move(A, offering(offerOf("trade", A, n % 2 === 0 ? B : C, 200 + n)), "propose");
      live.move(n % 2 === 0 ? B : C, facts(turn(A, 0)), "accept");
    }
    assert.equal(live.refusal(A, "propose"), null);
    assert.equal("offers" in live.record, false, "the record keeps no offer count");
  });

  test("EVIDENCE BOUND: a defaulting obligation with more facts than the window keeps a CHECKPOINTED window (the head before it, the newest events) and its seal still proves exactly its decision", () => {
    const t = new Table("live", { money: true });
    t.ok(pauseOp(t.record, A, { action: "request", kind: "pause", id: null }, t.t));
    for (const seat of [B, C]) t.ok(pauseOp(t.record, seat, { action: "yes", kind: "pause", id: t.record.pause.request?.id ?? null }, t.t));
    for (let i = 0; i < 300; i += 1) {
      t.t += MIN;
      t.ok(pauseOp(t.record, A, { action: "request", kind: "resume", id: null }, t.t));
      t.ok(pauseOp(t.record, C, { action: "no", kind: "resume", id: t.record.pause.request?.id ?? null }, t.t));
    }
    t.t += MIN;
    t.ok(pauseOp(t.record, A, { action: "request", kind: "resume", id: null }, t.t));
    for (const seat of [B, C]) t.ok(pauseOp(t.record, seat, { action: "yes", kind: "resume", id: t.record.pause.request?.id ?? null }, t.t));
    assert.equal(t.record.evidence.truncated, true, "more facts than the window: the oldest are checkpointed into its starting head");
    t.advance(LIVE_ACTION_MS + LIVE_CURE_MS);
    const remedy = t.record.remedy as NonNullable<GameClockRecord["remedy"]>;
    assert.deepEqual([remedy.kind, remedy.evidence.truncated], [1, true]);
    assert.ok(remedy.evidence.events.length <= CLOCK_EVIDENCE_WINDOW);
    assert.equal(evidenceHashOf(remedy.evidence), remedy.evidence_hash, "the checkpointed document folds to the attested hash");
    assert.equal(sealedRemedyProblem(GAME, remedy), null);
    assert.deepEqual(parseClockDocument(JSON.stringify(t.record), GAME).remedy, remedy, "restart-safe");
  });

  test("ASYNC: repeated rejected legal offers stay available -- no decline counter, no 10:00 response timer, the proposer resumes exactly", () => {
    const paced = new Table("async-pace", { pace: 86_400 });
    paced.advance(20 * HOUR);
    for (let n = 1; n <= 25; n += 1) {
      assert.equal(paced.refusal(A, "propose", { trainRecipient: B }), null, `Async offer ${n} is never blocked`);
      paced.move(A, offering(offerOf(n % 2 === 0 ? "train" : "private", A, B, n)), "propose", { trainRecipient: B });
      assert.equal(paced.record.obligation?.trade, null, "no Live response timer in Async");
      assert.equal(paced.remaining(), 86_400 * SEC, "the answerer owes an ordinary pace obligation");
      paced.move(B, facts(turn(A, 0)), "reject");
    }
    assert.equal(paced.remaining(), 4 * HOUR, "A resumes its 4 hours every time (no time passed: its running park lost nothing)");
    assert.deepEqual(paced.record.declines.counts, {}, "Async keeps no decline count");
    assert.deepEqual(clockViewOf(paced.record, paced.t).declines, []);
    const free = new Table("no-deadline");
    for (let n = 1; n <= 5; n += 1) {
      free.move(A, offering(offerOf("train", A, B, n)), "propose", { trainRecipient: B });
      free.move(B, facts(turn(A, 0)), "reject");
    }
    assert.deepEqual(free.record.declines.counts, {}, "No-deadline keeps none either");
    assert.equal(free.refusal(A, "propose", { trainRecipient: B }), null);
  });

  test("NO HISTORY CAP: past 5,000 log entries an offer is still legal, and the sealed remedy's evidence still proves exactly its decision (bounded window, checkpointed head, restart-safe)", () => {
    const t = new Table("async-pace", { pace: 86_400, money: true });
    /* 2,600 offer-and-reject cycles: 5,200 entries of negotiation, every one folded. */
    for (let n = 1; n <= 2_600; n += 1) {
      t.move(A, offering(offerOf("private", A, B, n)), "propose");
      t.move(B, facts(turn(A, 0)), "reject");
    }
    assert.ok(t.logLen > 5_000, "the history is past the old 5,000 bound");
    assert.equal(t.refusal(A, "propose"), null, "an offer is still legal: history length never changes the rules");
    /* The evidence the record keeps is the defaulting obligation's window, never the history's length. */
    assert.ok(t.record.evidence.window.length <= CLOCK_EVIDENCE_WINDOW);
    assert.ok(t.record.evidence.seq > 5_000, "every fact was hashed into the chain");
    assert.equal(foldEvidence(t.record.evidence.window_from, t.record.evidence.window), t.record.evidence.head, "the checkpointed window still folds to the head");
    /* The overdue and the N-1 money remedy: the sealed evidence proves exactly the sealed decision. */
    t.advance(86_400 * SEC);
    assert.equal(t.record.phase, "overdue");
    const nowSecs = Math.floor(t.t / 1000);
    t.ok(propose(t.record, B, "foreclose", { approve_until: nowSecs + 7 * 86_400, signature: "12".repeat(64) }, t.t));
    t.ok(vote(t.record, C, t.record.overdue?.proposal?.id as number, true, { approve_until: nowSecs + 7 * 86_400, signature: "34".repeat(64) }, t.t));
    const remedy = t.record.remedy as NonNullable<GameClockRecord["remedy"]>;
    assert.equal(remedy.kind, 5);
    assert.equal(remedy.log_len, t.logLen, "the stalled position is the full history's");
    assert.equal(evidenceHashOf(remedy.evidence), remedy.evidence_hash);
    assert.equal(sealedRemedyProblem(GAME, remedy), null, "the sealed decision verifies against its own evidence");
    /* Restart safety: the record round-trips byte for byte, and a break after the seal changes nothing of it. */
    const reloaded = parseClockDocument(JSON.stringify(t.record), GAME);
    assert.deepEqual(reloaded, t.record);
    const broken = continuityBreak(reloaded, { now: t.t + HOUR, preservedAt: t.t, reason: "restart", authority: "auth-2" }).record;
    assert.deepEqual(broken.remedy, remedy);
    assert.equal(broken.system, null);
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

  test("two declines (one rejection, one expiry) (train) block a third A -> B proposal until the next operating sub-round (round instance)", () => {
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
    /* The next operating sub-round (OR 1.1 -> OR 1.2) clears it. */
    t.move(A, facts(turn(B, 1), { roundKey: "OperatingRound/1/2" }));
    assert.deepEqual(t.record.declines, { round_key: "OperatingRound/1/2", counts: {}, offers: [] });
    assert.equal(t.refusal(A, "propose", { trainRecipient: B }), null);
  });

  test("an offer to oneself parks nothing and refreshes nothing -- proposed, withdrawn or accepted", () => {
    const t = new Table("live");
    t.advance(10 * MIN);
    const self = offerOf("train", A, A);
    t.move(A, offering(self), "propose");
    assert.equal(t.record.obligation?.trade, null);
    assert.equal(t.remaining(), 10 * MIN, "no refresh by proposing to oneself");
    t.move(A, facts(turn(A, 0)), "rescind");
    assert.equal(t.remaining(), 10 * MIN, "no refresh by withdrawing it either");
    t.move(A, offering(offerOf("train", A, A, 2)), "propose");
    t.advance(MIN);
    t.move(A, facts(turn(A, 0)), "accept");
    assert.equal(t.remaining(), 9 * MIN, "nor by accepting it: the clock ran on");
  });

  test("invalid offers never freeze: a proposal the gate refuses is never a batch -- the clock is exactly as it was (the engine's own refusals: clockController.test.ts)", () => {
    const t = new Table("live");
    /* Two declines A -> B this Operating Round: a third A -> B proposal is refused by the gate. */
    for (let n = 1; n <= 2; n += 1) {
      t.move(A, offering(offerOf("train", A, B, n)), "propose", { trainRecipient: B });
      t.move(B, facts(turn(A, 0)), "reject");
    }
    t.advance(9 * MIN);
    const before = t.record;
    assert.throws(() => t.move(A, offering(offerOf("train", A, B, 3)), "propose", { trainRecipient: B }), /refused: trade-declines/);
    assert.equal(t.record, before, "nothing folded");
    assert.equal(t.record.obligation?.trade, null);
    assert.equal(t.remaining(), 11 * MIN, "A's clock runs on, unfrozen");
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

  test("Async has no response timer: the answerer owes an ordinary pace allowance", () => {
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
    assert.equal(t.record.remedy?.replaces, null, "a sealed decision never replaces (or is replaced by) another");
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

  test("POST-TERMINAL: a break AFTER the seal pauses nothing and asks no vote -- the SAME sealed remedy stands, unchanged, with no cure and no alternate", () => {
    for (const kind of [1, 2] as const) {
      const t = new Table("live", { money: true });
      t.advance(LIVE_ACTION_MS);
      if (kind === 2) {
        const finalSecs = Math.ceil((T0 + LIVE_ACTION_MS + LIVE_CURE_MS) / 1000);
        t.ok(propose(t.record, B, "foreclose", { approve_until: finalSecs + 900, signature: "22".repeat(64) }, t.t));
        t.ok(vote(t.record, C, t.record.overdue!.proposal!.id, true, { approve_until: finalSecs + 900, signature: "33".repeat(64) }, t.t));
      }
      t.advance(LIVE_CURE_MS);
      assert.deepEqual([t.record.phase, t.record.remedy?.kind, t.record.remedy?.status], ["ended", kind, "sealed"]);
      const sealed = t.record.remedy;
      /* The server / AWS restart: another authority takes the record. */
      const reloaded = parseClockDocument(JSON.stringify(t.record), GAME);
      t.ok(continuityBreak(reloaded, { now: t.t + HOUR, preservedAt: t.t, reason: "lost", authority: "auth-2" }));
      assert.equal(t.record.system, null, "no SYSTEM PAUSE after a terminal seal: there is no gameplay to resume");
      assert.deepEqual(t.record.remedy, sealed, "the sealed decision is unchanged (never re-decided)");
      assert.deepEqual([t.record.phase, t.record.overdue?.cure?.since ?? null], ["ended", null], "no cure window reopens");
      /* No player vote is asked or possible; no alternate remedy can be proposed; no move is taken. */
      assert.equal("code" in systemResumeVote(t.record, A, t.t), true, "there is no system pause to vote on");
      assert.equal("code" in propose(t.record, B, "foreclose", null, t.t), true, "no new foreclosure vote");
      assert.equal(t.refusal(A)?.code, CLOCK_REFUSAL.ended, "the defaulter gets no cure opportunity");
      const view = clockViewOf(t.record, t.t);
      assert.deepEqual([view.state, view.system, view.remedy?.kind], ["ended", null, kind]);
    }
  });

  test("POST-TERMINAL: a sealed first / second overdue survives a restart exactly (strike 2 neutral annulment and foreclosure)", () => {
    const t = new Table("live", { money: true });
    t.advance(LIVE_ACTION_MS);
    t.move(A, facts(turn(A, 0)));
    t.advance(LIVE_ACTION_MS + LIVE_CURE_MS);
    const sealed = t.record.remedy as NonNullable<GameClockRecord["remedy"]>;
    assert.deepEqual([sealed.kind, sealed.strike, t.record.ended?.kind], [1, 2, "live-timeout-annul"]);
    let record = t.record;
    for (const authority of ["auth-2", "auth-3"]) record = continuityBreak(parseClockDocument(JSON.stringify(record), GAME), { now: t.t + HOUR, preservedAt: t.t, reason: "restart", authority }).record;
    assert.deepEqual([record.remedy, record.system, record.ended?.kind], [sealed, null, "live-timeout-annul"]);
    assert.equal(sealedRemedyProblem(GAME, record.remedy as NonNullable<GameClockRecord["remedy"]>), null);
  });

  test("POST-TERMINAL: strike 3 stays gameplay-terminal across a restart; its sealed foreclosure (the challengeable remedy 3) is unchanged", () => {
    const t = new Table("live", { money: true });
    for (let strike = 1; strike <= 2; strike += 1) {
      t.advance(LIVE_ACTION_MS);
      t.move(A, facts(turn(A, 0)));
    }
    t.advance(LIVE_ACTION_MS);
    const sealed = t.record.remedy as NonNullable<GameClockRecord["remedy"]>;
    assert.deepEqual([sealed.kind, t.record.ended?.kind], [3, "live-strike3-foreclosure"]);
    const after = continuityBreak(parseClockDocument(JSON.stringify(t.record), GAME), { now: t.t + 3 * HOUR, preservedAt: t.t, reason: "restart", authority: "auth-2" }).record;
    assert.deepEqual([after.phase, after.system, after.remedy], ["ended", null, sealed]);
    assert.equal(gate(after, { actor: A, msg: "move", closeRoom: false, revertTarget: null, trainRecipient: null, nameOf: (x) => x })?.code, CLOCK_REFUSAL.ended, "gameplay never reopens");
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

  test("undoing one's OWN action that passed responsibility restores one's remainder, charged the time since (an act-handoff-undo cycle can never stall the table)", () => {
    const t = new Table("live");
    t.advance(12 * MIN);
    t.move(A, facts(turn(B, 1)));
    const actIndex = t.index;
    t.advance(4 * MIN);
    t.move(A, facts(turn(A, 0)), "revert", { revertTarget: actIndex });
    assert.deepEqual([t.record.obligation?.seat, t.remaining()], [A, 4 * MIN], "8:00 left at the act, less the 4:00 since");
    /* The cycle that would stall B forever: A re-acts, B gets 20:00, A undoes again at B's 19:50 -- A pays every time. */
    t.move(A, facts(turn(B, 1)));
    const again = t.index;
    t.advance(3 * MIN + 59 * SEC);
    t.move(A, facts(turn(A, 0)), "revert", { revertTarget: again });
    assert.equal(t.remaining(), 1 * SEC);
  });

  test("undoing a rejection restores the recipient's response time; the decline is NOT given back", () => {
    const t = new Table("live");
    t.move(A, offering(offerOf("train", A, B)), "propose", { trainRecipient: B });
    t.advance(4 * MIN);
    t.move(B, facts(turn(A, 0)), "reject");
    const rejectIndex = t.index;
    t.advance(MIN);
    t.move(B, offering(offerOf("train", A, B)), "revert", { revertTarget: rejectIndex });
    assert.deepEqual([t.record.obligation?.seat, t.remaining(), t.record.declines.counts[`${A}>${B}`]], [B, 5 * MIN, 1], "6:00 at the reject, less the 1:00 since; the decline stays");
    assert.equal(t.record.parked[0]?.seat, A);
    /* Rejecting the SAME offer again is the same decline: one offer is declined at most once. */
    t.move(B, facts(turn(A, 0)), "reject");
    assert.equal(t.record.declines.counts[`${A}>${B}`], 1);
  });

  test("REVIEW: undoing the answer to an offer never gives its proposer back the run it had since -- an accept-and-undo cycle only ever runs the proposer's clock down", () => {
    const t = new Table("live");
    t.advance(15 * MIN); // A has 5:00
    let left = 5 * MIN;
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      t.move(A, offering(offerOf("trade", A, B, cycle)), "propose");
      t.advance(30 * SEC);
      t.move(B, facts(turn(A, 0)), "accept");
      const acceptIndex = t.index;
      assert.equal(t.remaining(), left, `cycle ${cycle}: accepted, A resumes its exact remainder`);
      t.advance(10 * SEC);
      /* A (the host's last-action undo) takes back B's acceptance: the offer stands again, A parked behind it. */
      t.move(A, offering(offerOf("trade", A, B, cycle)), "revert", { revertTarget: acceptIndex });
      const park = t.record.parked.find((p) => p.seat === A);
      assert.equal(park?.remaining_ms, left - 10 * SEC, `cycle ${cycle}: the 10 s A ran since the acceptance stay charged`);
      left -= 10 * SEC;
      t.move(B, facts(turn(A, 0)), "reject");
      assert.equal(t.remaining(), left);
    }
    assert.equal(left, 5 * MIN - 40 * SEC);
  });

  test("REVIEW: a recovered gap keeps a re-proposing proposer's remainder (never a fresh allowance), and resumes a closed offer's park only for the same decision", () => {
    /* L1: the record folded A's first proposal (A parked at 5:00); the gap holds B's rejection and A's second proposal. */
    const t = new Table("live");
    t.advance(15 * MIN);
    t.move(A, offering(offerOf("trade", A, B, 1)), "propose");
    t.advance(MIN);
    const second = offering(offerOf("trade", A, B, 2));
    t.take(recoverGap(t.record, { now: t.t, lastIndex: t.index + 2, lastAt: t.t, actors: [B], facts: second }));
    assert.deepEqual(t.record.parked.map((p) => [p.seat, p.remaining_ms]), [[A, 5 * MIN]], "A keeps its 5:00, never a fresh 20:00");
    /* L2: a gap in which A took its own required action and now owes a NEW decision: fresh, not the stale park. */
    const u = new Table("live");
    u.advance(15 * MIN);
    u.move(A, offering(offerOf("trade", A, B, 1)), "propose");
    u.advance(MIN);
    u.take(recoverGap(u.record, { now: u.t, lastIndex: u.index + 3, lastAt: u.t, actors: [B, A], facts: facts(turn(A, 7)) }));
    assert.deepEqual([u.record.obligation?.seat, u.remaining()], [A, LIVE_ACTION_MS], "A acted in the gap: a genuine new obligation");
    const v = new Table("live");
    v.advance(15 * MIN);
    v.move(A, offering(offerOf("trade", A, B, 1)), "propose");
    v.advance(MIN);
    v.take(recoverGap(v.record, { now: v.t, lastIndex: v.index + 1, lastAt: v.t, actors: [B], facts: facts(turn(A, 0)) }));
    assert.deepEqual([v.record.obligation?.seat, v.remaining()], [A, 5 * MIN], "B answered in the gap: A resumes its same decision's 5:00");
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

  test("REVIEW: a parked negotiation never restarts the window -- the sealed document still holds the defaulting obligation's ORIGINAL grant and every park / resume since", () => {
    const t = new Table("live", { money: true });
    t.move(A, facts(turn(B, 1)));
    t.advance(3 * MIN);
    for (let n = 1; n <= 3; n += 1) {
      t.move(B, offering(offerOf("private", B, C, n)), "propose");
      t.advance(MIN);
      t.move(C, facts(turn(B, 1)), "reject");
    }
    t.advance(LIVE_ACTION_MS - 3 * MIN + LIVE_CURE_MS);
    const doc = t.record.remedy!.evidence;
    const kinds = doc.events.map((event) => event.kind);
    assert.equal(doc.events[0].kind, "responsibility");
    assert.deepEqual([doc.events[0].f.seat, doc.events[0].f.timer_ms, doc.events[0].f.reason], [B, LIVE_ACTION_MS, "handoff"], "the original 20:00 grant");
    assert.equal(kinds.filter((k) => k === "trade-begin").length, 3, "every park, with its exact parked remainder");
    assert.equal(kinds.filter((k) => k === "trade-end").length, 3);
    assert.deepEqual(kinds.slice(-3), ["overdue", "final", "remedy-sealed"]);
    assert.equal(sealedRemedyProblem(GAME, t.record.remedy!), null);
  });

  test("REVIEW: after the seal the record's own window restarts (the remedy document holds the sealed one): the record stays well inside a store's item limit even with a full window", () => {
    const t = new Table("live", { money: true, seats: [A, B, C] });
    t.ok(pauseOp(t.record, A, { action: "request", kind: "pause", id: null }, t.t));
    for (const seat of [B, C]) t.ok(pauseOp(t.record, seat, { action: "yes", kind: "pause", id: t.record.pause.request?.id ?? null }, t.t));
    for (let i = 0; i < 300; i += 1) {
      t.t += MIN;
      t.ok(pauseOp(t.record, A, { action: "request", kind: "resume", id: null }, t.t));
      t.ok(pauseOp(t.record, C, { action: "no", kind: "resume", id: t.record.pause.request?.id ?? null }, t.t));
    }
    t.t += MIN;
    t.ok(pauseOp(t.record, A, { action: "request", kind: "resume", id: null }, t.t));
    for (const seat of [B, C]) t.ok(pauseOp(t.record, seat, { action: "yes", kind: "resume", id: t.record.pause.request?.id ?? null }, t.t));
    t.advance(LIVE_ACTION_MS + LIVE_CURE_MS);
    const record = t.record as GameClockRecord;
    assert.equal(record.remedy?.evidence.events.length, CLOCK_EVIDENCE_WINDOW, "the sealed window is full");
    assert.ok(record.evidence.window.length <= 2, "the record's own window restarted at the seal");
    assert.equal(record.evidence.window_from, record.remedy?.evidence_hash, "from the sealed head");
    assert.equal(foldEvidence(record.evidence.window_from, record.evidence.window), record.evidence.head);
    const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    assert.ok(bytes < 300_000, `the record is ${bytes} bytes (DynamoDB's item limit is 400 KB)`);
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

  test("PAUSE requests are bounded per obligation (a new obligation opens a new window); RESUME requests are never refused outright (past a burst, one a minute)", () => {
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
    for (let i = 0; i < 16; i += 1) {
      t.ok(pauseOp(t.record, A, { action: "request", kind: "resume", id: null }, t.t));
      t.ok(pauseOp(t.record, C, { action: "no", kind: "resume", id: t.record.pause.request?.id ?? null }, t.t));
    }
    const burst = pauseOp(t.record, A, { action: "request", kind: "resume", id: null }, t.t);
    assert.equal("code" in burst ? burst.code : null, "rate-limited", "past the burst, one a minute");
    t.t += MIN;
    t.ok(pauseOp(t.record, A, { action: "request", kind: "resume", id: null }, t.t));
    assert.equal(t.record.pause.request?.kind, "resume", "a paused table can always ask to resume (never refused outright)");
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

  test("Live money: a complete foreclosure decides minute 30 when every approval is VALID AT FINALITY (owner ruling, 2026-10-07: no relay margin); one ending at the final second cannot", () => {
    const finalSecs = Math.ceil((T0 + LIVE_ACTION_MS + LIVE_CURE_MS) / 1000);
    const lapsing = new Table("live", { money: true });
    lapsing.advance(LIVE_ACTION_MS);
    lapsing.ok(propose(lapsing.record, B, "foreclose", sig(finalSecs + 1), lapsing.t));
    lapsing.ok(vote(lapsing.record, C, lapsing.record.overdue?.proposal?.id as number, true, sig(finalSecs, "55"), lapsing.t));
    assert.equal(clockViewOf(lapsing.record, lapsing.t).overdue?.outcomeIfUncured, "timeout-annul", "C's approval ends AT the final second: not valid at finality");
    lapsing.advance(LIVE_CURE_MS);
    assert.equal(lapsing.record.ended?.kind, "live-timeout-annul");
    assert.equal(lapsing.record.remedy?.kind, 1);
    const valid = new Table("live", { money: true });
    valid.advance(LIVE_ACTION_MS);
    valid.ok(propose(valid.record, B, "foreclose", sig(finalSecs + 1), valid.t));
    valid.ok(vote(valid.record, C, valid.record.overdue?.proposal?.id as number, true, sig(finalSecs + 1, "55"), valid.t));
    assert.equal(clockViewOf(valid.record, valid.t).overdue?.outcomeIfUncured, "foreclosure", "one second past minute 30 decides it");
    valid.advance(LIVE_CURE_MS);
    assert.equal(valid.record.ended?.kind, "live-foreclosure");
    assert.equal(valid.record.remedy?.kind, 2);
    assert.deepEqual(valid.record.remedy?.approvals.map((a) => a.approve_until), [finalSecs + 1, finalSecs + 1], "sealed with approvals that end a second after finality: the contract judges them at final_at");
  });

  test("Live money: a key that moved AT or before minute 30 voids that YES before the seal (the neutral outcome); the check binds its overdue, proposal and final second; no check (chain unread) decides on the vote-time checks", () => {
    const finalSecs = Math.ceil((T0 + LIVE_ACTION_MS + LIVE_CURE_MS) / 1000);
    const complete = () => {
      const t = new Table("live", { money: true });
      t.advance(LIVE_ACTION_MS);
      t.ok(propose(t.record, B, "foreclose", sig(finalSecs + 600), t.t));
      t.ok(vote(t.record, C, t.record.overdue?.proposal?.id as number, true, sig(finalSecs + 600, "55"), t.t));
      return t;
    };
    const at = T0 + LIVE_ACTION_MS + LIVE_CURE_MS;
    /* The controller asks for a check exactly when minute 30 falls due, with the standing YES approvals. */
    const t0 = complete();
    assert.equal(finalityKeyCheckDue(t0.record, at - 1), null, "not yet due");
    const due = finalityKeyCheckDue(t0.record, at);
    assert.deepEqual([due?.epoch, due?.final_secs, due?.votes.map((v) => v.seat)], [1, finalSecs, [B, C]]);
    const id = t0.record.overdue?.proposal?.id as number;
    /* C's key moved at or before the final second: C's YES is void, the consensus incomplete -> the neutral outcome. */
    const moved = complete();
    moved.t = at;
    moved.take(advance(moved.record, at, () => ({ len: moved.logLen, hash: HASH }), { epoch: 1, proposal: id, final_secs: finalSecs, stale: [C] }));
    assert.equal(moved.record.ended?.kind, "live-timeout-annul");
    assert.equal(moved.record.remedy?.kind, 1);
    assert.ok(moved.events.includes("vote-stale"));
    /* A check for another proposal, or another final second, decides nothing (the foreclosure stands). */
    for (const keys of [{ epoch: 1, proposal: id + 1, final_secs: finalSecs, stale: [C] }, { epoch: 1, proposal: id, final_secs: finalSecs + 1, stale: [C] }, { epoch: 2, proposal: id, final_secs: finalSecs, stale: [C] }]) {
      const other = complete();
      other.take(advance(other.record, at, () => ({ len: other.logLen, hash: HASH }), keys));
      assert.equal(other.record.ended?.kind, "live-foreclosure", JSON.stringify(keys));
    }
    /* No seat moved (or no check was asked for -- a server with no chain reader): the foreclosure is sealed. */
    for (const keys of [{ epoch: 1, proposal: id, final_secs: finalSecs, stale: [] }, null]) {
      const kept = complete();
      kept.take(advance(kept.record, at, () => ({ len: kept.logLen, hash: HASH }), keys));
      assert.equal(kept.record.ended?.kind, "live-foreclosure");
      assert.equal(kept.record.remedy?.kind, 2);
    }
    /* The chain could not be read conclusively: minute 30 is NOT processed (fail closed); later, with a conclusive
       read, it is decided at its own moment. */
    const pending = complete();
    const stopped = advance(pending.record, at + 5_000, () => ({ len: pending.logLen, hash: HASH }), FINALITY_KEYS_UNREAD);
    assert.equal(stopped.finalityPending, true);
    pending.take(stopped);
    assert.deepEqual([pending.record.phase, pending.record.remedy, pending.record.ended], ["overdue", null, null]);
    pending.take(advance(pending.record, at + 60_000, () => ({ len: pending.logLen, hash: HASH }), { epoch: 1, proposal: id, final_secs: finalSecs, stale: [] }));
    assert.deepEqual([pending.record.ended?.kind, pending.record.remedy?.final_ms], ["live-foreclosure", at]);
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

  test("Async money: an approval VALID at the completing vote completes the consensus (final at once -- owner ruling, 2026-10-07: no margin); one that lapsed by then is set aside", () => {
    const short = new Table("async-pace", { pace: 86_400, money: true });
    short.advance(86_400 * SEC);
    const nowSecs = Math.ceil(short.t / 1000);
    short.ok(propose(short.record, B, "foreclose", sig(nowSecs + 1), short.t));
    short.ok(vote(short.record, C, short.record.overdue?.proposal?.id as number, true, sig(nowSecs + 7 * 86_400, "55"), short.t));
    assert.equal(short.record.ended?.kind, "async-foreclosure", "B's approval is valid at the completion: final");
    assert.equal(short.record.remedy?.kind, 5);
    const lapsed = new Table("async-pace", { pace: 86_400, money: true });
    lapsed.advance(86_400 * SEC);
    const then = Math.ceil(lapsed.t / 1000);
    lapsed.ok(propose(lapsed.record, B, "foreclose", sig(then + 10), lapsed.t));
    lapsed.advance(10 * SEC);
    lapsed.ok(vote(lapsed.record, C, lapsed.record.overdue?.proposal?.id as number, true, sig(then + 7 * 86_400, "55"), lapsed.t));
    assert.equal(lapsed.record.phase, "overdue");
    assert.deepEqual(lapsed.record.overdue?.proposal?.votes.map((v) => v.seat), [C], "B's YES lapsed before the completion: set aside; B is asked again");
  });

  test("REVIEW: seats named unlandable are cleared once the SAME decision is carried on again; a pre-correction record (with its offer budget) still reads", () => {
    const t = new Table("async-pace", { pace: 86_400, money: true });
    t.advance(86_400 * SEC);
    const nowSecs = Math.floor(t.t / 1000);
    t.ok(propose(t.record, B, "foreclose", sig(nowSecs + 7 * 86_400), t.t));
    t.ok(vote(t.record, C, t.record.overdue?.proposal?.id as number, true, sig(nowSecs + 7 * 86_400, "55"), t.t));
    t.take(remedyBlocked(t.record, [C], "owner decision required", t.t));
    assert.deepEqual(clockViewOf(t.record, t.t).remedy?.stale, [C]);
    t.take(remedyProgress(t.record, "submitted", null, t.t, true));
    assert.deepEqual([t.record.remedy?.status, t.record.remedy?.stale], ["submitted", []]);
    const legacy = JSON.stringify({ ...t.record, offers: { key: "OperatingRound/1/1", counts: { [A]: 3 } } });
    assert.deepEqual(parseClockDocument(legacy, GAME), t.record, "the legacy offer budget is dropped on read; nothing else changes");
  });

  test("a sealed N-1 decision whose approvals can no longer land is HELD unchanged (owner decision required): never converted, never re-voted", () => {
    const t = new Table("async-pace", { pace: 86_400, money: true });
    t.advance(86_400 * SEC);
    const nowSecs = Math.floor(t.t / 1000);
    t.ok(propose(t.record, B, "foreclose", sig(nowSecs + 7 * 86_400), t.t));
    t.ok(vote(t.record, C, t.record.overdue?.proposal?.id as number, true, sig(nowSecs + 7 * 86_400, "55"), t.t));
    const sealed = t.record.remedy as NonNullable<GameClockRecord["remedy"]>;
    assert.equal(sealed.kind, 5);
    t.take(remedyBlocked(t.record, [C], "owner decision required: approvals lapsed", t.t));
    const held = t.record.remedy as NonNullable<GameClockRecord["remedy"]>;
    assert.deepEqual([held.status, held.stale, held.detail], ["refused", [C], "owner decision required: approvals lapsed"]);
    assert.deepEqual(
      [held.kind, held.seat, held.epoch, held.log_len, held.log_hash, held.final_ms, held.evidence_hash, held.approvals, held.replaces],
      [sealed.kind, sealed.seat, sealed.epoch, sealed.log_len, sealed.log_hash, sealed.final_ms, sealed.evidence_hash, sealed.approvals, null],
      "the SAME decision: nothing converted, nothing resealed",
    );
    assert.equal(sealedRemedyProblem(GAME, held), null, "and still exactly what its evidence proves");
    assert.equal(t.record.overdue?.proposal?.complete_at !== null, true);
    assert.equal("code" in propose(t.record, C, "annul", sig(nowSecs + 7 * 86_400), t.t), true, "no new vote can be opened");
    const again = remedyBlocked(t.record, [C], "owner decision required: approvals lapsed", t.t + MIN);
    assert.equal(again.events.length, 0, "an unchanged block writes nothing");
    assert.equal(remedyBlocked({ ...t.record, remedy: { ...held, kind: 1 } }, [C], "x", t.t).events.length, 0, "remedies 1 and 3 carry no approvals: never blocked this way");
  });
});

describe("Review fixes (second pass): unanimous annulment everywhere, ended pauses", () => {
  test("a free table annuls unanimously from plain active Live, from a pending Live foreclosure, from an Async overdue and from No-deadline", () => {
    const all = (t: Table) => {
      for (const seat of [A, B, C]) t.ok(annulVote(t.record, seat, true, t.t));
      assert.equal(t.record.ended?.kind, "annulled");
      assert.equal(t.record.remedy, null, "a free table moves no money");
    };
    const live = new Table("live");
    live.advance(5 * MIN);
    all(live);
    const pending = new Table("live");
    pending.advance(LIVE_ACTION_MS);
    pending.ok(propose(pending.record, B, "foreclose", null, pending.t));
    pending.ok(vote(pending.record, C, pending.record.overdue?.proposal?.id as number, true, null, pending.t));
    assert.equal(pending.record.overdue?.proposal?.complete_at !== null, true, "the foreclosure is pending minute 30");
    all(pending);
    const paced = new Table("async-pace", { pace: 43_200 });
    paced.advance(43_200 * SEC);
    assert.equal(paced.record.phase, "overdue");
    all(paced);
    all(new Table("no-deadline"));
  });

  test("a game that ends while SYSTEM-PAUSED (a unanimous annulment) carries no pause: nothing is timed once it ended", () => {
    const t = new Table("live");
    t.advance(5 * MIN);
    t.ok(continuityBreak(t.record, { now: t.t + MIN, preservedAt: t.t, reason: "restart", authority: "auth-2" }));
    assert.notEqual(t.record.system, null);
    for (const seat of [A, B, C]) t.ok(annulVote(t.record, seat, true, t.t));
    assert.deepEqual([t.record.phase, t.record.system, t.record.pause.paused_at], ["ended", null, null]);
    assert.equal(clockViewOf(t.record, t.t).system, null);
  });
});

describe("Review fixes (third pass): the strike ledger proves the strike a remedy attests", () => {
  test("a third-strike foreclosure's evidence carries every overdue and cure of the game; its fold is the head the seal event names", () => {
    const t = new Table("live", { money: true });
    for (let strike = 1; strike <= 2; strike += 1) {
      t.advance(LIVE_ACTION_MS);
      t.move(A, facts(turn(A, 0)));
    }
    t.advance(LIVE_ACTION_MS);
    const remedy = t.record.remedy as NonNullable<GameClockRecord["remedy"]>;
    assert.equal(remedy.kind, 3);
    const doc = remedy.evidence;
    assert.deepEqual(doc.ledger.events.map((e) => [e.kind, e.f.strike]), [["overdue", 1], ["cure", 1], ["overdue", 2], ["cure", 2], ["overdue", 3]]);
    assert.equal(doc.ledger.from, ledgerGenesisHead(GAME));
    const seal = doc.events[doc.events.length - 1];
    assert.equal(seal.kind, "remedy-sealed");
    assert.equal(seal.f.ledger_head, ledgerHeadOf(doc), "the signed chain commits to the ledger through the seal event");
    assert.equal(evidenceHashOf(doc), remedy.evidence_hash, "and the attested hash is still the main chain's head");
  });
});

describe("Review fixes (fourth pass): restart credit, approval renewal", () => {
  test("an Async restart credits only the outage: a table nobody opened after the new server began is charged that time", () => {
    const t = new Table("async-pace", { pace: 86_400 });
    t.advance(2 * HOUR); // the last proof: 22 h left
    const proven = t.t;
    const serverStarted = proven + 30 * MIN; // the old server died, the new one started half an hour later
    t.t = proven + 18 * HOUR; // first opened 18 h after the last proof
    t.ok(continuityBreak(t.record, { now: t.t, preservedAt: proven, reason: "restart", authority: "auth-2", resumeFrom: serverStarted }));
    assert.equal(t.remaining(), 22 * HOUR - (18 * HOUR - 30 * MIN), "only the 30-minute outage is credited");
  });

  test("a money YES whose consent key moved is RENEWED by a new approval even at the same horizon; otherwise a re-vote that does not reach a minute further is ignored", () => {
    const t = new Table("live", { money: true });
    t.advance(LIVE_ACTION_MS);
    const until = 9_999_999_999;
    t.ok(propose(t.record, B, "foreclose", { approve_until: until, signature: "44".repeat(64) }, t.t));
    const id = t.record.overdue?.proposal?.id as number;
    const ignored = vote(t.record, B, id, true, { approve_until: until, signature: "55".repeat(64) }, t.t);
    assert.equal("code" in ignored ? null : ignored.events.length, 0);
    t.ok(vote(t.record, B, id, true, { approve_until: until, signature: "55".repeat(64) }, t.t, { renew: true }));
    assert.equal(t.record.overdue?.proposal?.votes.find((v) => v.seat === B)?.approval?.signature, "55".repeat(64));
  });
});
