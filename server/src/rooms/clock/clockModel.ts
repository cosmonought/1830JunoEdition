// server/src/rooms/clock/clockModel.ts
//
// ==================================================================
//  PHASE 3 FINAL CLOCKS: THE STATE MACHINE (PURE) -- LIVE 20/30, TRAIN RESPONSE, STRIKES, VOTES, PAUSES, ASYNC
// ==================================================================
//
// Every function here is PURE: a record and facts in, a new record (and the evidence events it appended, and the
// effects the controller owes) out. No I/O, no clock of its own: every time is handed in, every time is an integer ms.
// The controller (`clockController.ts`) calls these INSIDE the game's serialized task, so the order of clock facts and
// moves is the actor's order -- the "serialized authoritative ordering" the owner's race rules are judged by.
//
// THE RESPONSIBILITY MODEL. The clock times one OBLIGATION: the human who owes the next required decision
// (`requiredDecisionOf`), with one countdown:
//   - Live: 20:00 per required action. When the responsible human's accepted action leaves them owing the next one,
//     they get a fresh 20:00; when it passes responsibility, the new responsible human gets a fresh 20:00.
//   - Timed Async: the table's pace, the same way.
//   - No-deadline: no countdown at all.
// A refused, stale or duplicate submission is never a batch, so it never reaches here; chat, reconnects, opening UI and
// spectators are not moves. An accepted move by SOMEONE ELSE that leaves the obligation where it was (an off-turn M&H
// request) changes nothing; one that moves it starts the new obligation fresh.
//
// OFFERS. A proposal (train, private, funding, private trade) by the responsible human whose answerer is SOMEONE ELSE
// parks the proposer's remaining time and starts the answerer's obligation; on Live a TRAIN offer gives the answerer a
// distinct 10:00 RESPONSE timer instead of an action clock (it is never an overdue timer). The answer (accept / reject)
// is the answerer's completed decision: the proposer's next decision starts fresh. A rescission, or a Live train offer
// left unanswered for 10:00, resumes the proposer's parked time EXACTLY (never a fresh 20:00). A rejection or an
// unanswered expiry counts one DECLINE for that direction in the current Operating Round; two block a third proposal
// in that direction until the next OR. An offer to oneself parks nothing and refreshes nothing until it is accepted.
//
// OVERDUE (Live). At 20:00 the seat is OVERDUE: its durable overdue count rises; the first and second open a 10-minute
// cure window (gameplay is INTERRUPTED: only the overdue seat's own owed action is taken, and it cures); the N-1
// foreclosure vote only decides what happens at minute 30 (a NO vetoes; abstention is incomplete; completion does NOT
// execute early); at minute 30 an uncured seat's game ends -- foreclosed if a complete, still-valid N-1 approval
// stands, neutrally annulled otherwise. The third expiry ends the game at once by foreclosure (no cure, no vote;
// the money is challengeable on chain, the game is not reopened).
// OVERDUE (Timed Async). Expiry marks the seat OVERDUE and nothing else: no money moves, no grace timer, no
// interruption. The other N-1 may unanimously propose neutral annulment or foreclosure; a NO vetoes; completion is
// final at once. A cure (the seat's owed action) before completion ends the instance and moots the proposal.
//
// PAUSES. A voluntary pause (Live) needs every seated player's YES to begin and to end; it freezes whatever timer runs,
// exactly, for as long as it lasts. A SYSTEM PAUSE (a continuity break) is entered by the server with no vote, freezes
// every timer at the last instant continuity was proven, stales any not-yet-final votes, and needs every seated
// player's YES to end. Outage time is never charged: it never creates an overdue, a strike, a finality or an expiry.
//
// UNDO. A standing undo restores the obligation the undone batch replaced, from the snapshot taken before it -- never
// a fresh allowance -- and charges any time the current run had already used if that run began at the undone batch
// (an act-and-undo can never extend a clock). No undo reaches at or before a fence (`undo_floor`: a cure, an expiry, a
// pause, a system pause, a recovered gap); none is taken while a seat is overdue; declines and strikes never go back.

import type { RequiredDecision, RequiredDecisionKind, StandingOffer } from "../../../../frontend/src/gameEngine/clockResponsibility";
import type { ClockDeadlineClass, ClockEndKind, ClockProposalKind, RoomClockView } from "../../../../frontend/src/utils/clockProtocol";
import { CLOCK_REFUSAL, declinesReachedSentence, STRIKE_TWO_WARNING, SYSTEM_PAUSE_RESUME_SENTENCE, SYSTEM_PAUSE_SENTENCE } from "../../../../frontend/src/utils/clockProtocol";
import { genesisHead, nextHead, signatureDigest, CLOCK_EVIDENCE_FORMAT, type ClockEvidenceEvent, type ClockEvidenceKind } from "./clockEvidence";
import {
  ASYNC_PACES_SECS,
  CLOCK_EVIDENCE_WINDOW,
  CLOCK_FORMAT,
  CLOCK_PAUSE_REQUESTS_PER_OBLIGATION,
  CLOCK_PROPOSALS_PER_OVERDUE,
  CLOCK_SNAPSHOT_LIMIT,
  CLOCK_VERSION,
  LIVE_ACTION_MS,
  LIVE_CURABLE_OVERDUES,
  LIVE_CURE_MS,
  LIVE_DECLINES_PER_OR,
  LIVE_TRADE_MS,
  type ClockEnded,
  type ClockObligation,
  type ClockOverdue,
  type ClockParked,
  type ClockProposal,
  type ClockRemedy,
  type ClockSnapshot,
  type ClockTimer,
  type ClockVote,
  type GameClockRecord,
  type RemedyKind,
  type RemedyStatus,
} from "./clockRecord";

/* ==================================================================
    INPUTS
   ================================================================== */

/** What a committed board says, for the clock (the controller reads it through `clockResponsibility.ts`). */
export interface ClockBoardFacts {
  /** GameEnd. */
  readonly over: boolean;
  /** The room closed (CloseRoom). */
  readonly closed: boolean;
  readonly seats: readonly string[];
  readonly decision: RequiredDecision | null;
  readonly offer: StandingOffer | null;
  /** The Operating Round (`OperatingRound/macro/sub`), or `null` outside one. */
  readonly orKey: string | null;
}

/** `optional`: an accepted action that is never a REQUIRED decision (a private company's own power, taken at any time):
 *  it neither refreshes a clock nor cures an overdue. */
export type ClockMsgClass = "deal" | "move" | "revert" | "propose" | "accept" | "reject" | "rescind" | "server-expiry" | "optional";

/** One committed batch, as the clock folds it. */
export interface ClockBatch {
  /** The seat that submitted it (the server's own expiry names the proposer it rescinds for). */
  readonly actor: string;
  readonly first: number;
  readonly last: number;
  /** The batch's server stamp (the task's pinned time: every entry of it carries this `at`). */
  readonly at: number;
  readonly msg: ClockMsgClass;
  readonly revertTarget: number | null;
  readonly before: ClockBoardFacts;
  readonly after: ClockBoardFacts;
}

/** The log position the controller supplies when an overdue is decided (committed entries, and their hash). */
export type LogPosition = () => { readonly len: number; readonly hash: string };

export type ClockEffect =
  /** Money: a cure ended an overdue instance -- post a fencing checkpoint past the stall. */
  | { readonly kind: "fence-checkpoint"; readonly epoch: number }
  /** Money: a remedy decision was sealed -- the pipeline attests and relays it. */
  | { readonly kind: "remedy" }
  /** Live: a train offer's response timer ran out at `at` -- the controller closes the offer in the log. */
  | { readonly kind: "trade-expiry"; readonly at: number; readonly offerKey: string; readonly proposer: string; readonly recipient: string };

export interface ClockStep {
  readonly record: GameClockRecord;
  readonly events: readonly ClockEvidenceEvent[];
  readonly effects: readonly ClockEffect[];
}

export type ClockRefusal = { readonly code: string; readonly reason: string };

/* ==================================================================
    TIMERS
   ================================================================== */

const clamp = (value: number): number => (Number.isSafeInteger(value) && value > 0 ? value : 0);

/** Whole seconds of a ms instant, rounded UP (an attested moment is never earlier than the fact) -- integers only. */
export const secsUpOf = (ms: number): number => Number((BigInt(ms) + BigInt(999)) / BigInt(1000));
/** Whole seconds of a ms instant, rounded DOWN -- integers only. */
export const secsDownOf = (ms: number): number => Number(BigInt(ms) / BigInt(1000));

/** Live: a foreclosure's approvals must outlive its finality by this much (seconds) to decide minute 30 -- the relay's
 *  room to land it before the first approval lapses. Shorter, or lapsed: the neutral timeout annulment. */
export const LIVE_FINALITY_APPROVAL_MARGIN_SECS = 300;
/** Async (money): an approval counts toward completing the N-1 consensus only while it outlives the completion by this
 *  much (seconds); a seat whose approval has less left is asked to approve again (its YES is set aside). */
export const ASYNC_COMPLETION_APPROVAL_MARGIN_SECS = 3_600;

export function remainingAt(timer: ClockTimer, at: number): number {
  if (timer.since === null || at <= timer.since) return timer.remaining_ms;
  return clamp(timer.remaining_ms - (at - timer.since));
}

export function dueOf(timer: ClockTimer | null): number | null {
  return timer === null || timer.since === null ? null : timer.since + timer.remaining_ms;
}

const freeze = (timer: ClockTimer, at: number): ClockTimer => (timer.since === null ? timer : { remaining_ms: remainingAt(timer, at), since: null });
const run = (timer: ClockTimer, at: number): ClockTimer => (timer.since !== null ? timer : { remaining_ms: timer.remaining_ms, since: at });

/** The allowance of one ordinary obligation: Live 20:00, the Async pace, or `null` (No-deadline). */
export function allowanceOf(record: Pick<GameClockRecord, "policy">): number | null {
  if (record.policy.class === "live") return LIVE_ACTION_MS;
  if (record.policy.class === "async-pace" && record.policy.pace_secs !== null) return record.policy.pace_secs * 1000;
  return null;
}

export function allowanceSecsOf(record: Pick<GameClockRecord, "policy">): number | null {
  if (record.policy.class === "live") return 1_200; // LIVE_ACTION_MS (20:00), the escrow's Live allowance
  if (record.policy.class === "async-pace") return record.policy.pace_secs;
  return null;
}

/* ==================================================================
    THE DRAFT (a mutable copy, the events it appends, the effects it owes)
   ================================================================== */

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

class Draft {
  readonly d: Mutable<GameClockRecord>;
  readonly events: ClockEvidenceEvent[] = [];
  readonly effects: ClockEffect[] = [];
  private changed = false;

  constructor(
    private readonly original: GameClockRecord,
    private readonly now: number,
  ) {
    this.d = { ...original };
  }

  touch(): void {
    this.changed = true;
  }

  emit(kind: ClockEvidenceKind, at: number, f: ClockEvidenceEvent["f"]): ClockEvidenceEvent {
    this.changed = true;
    const ev = this.d.evidence;
    const event: ClockEvidenceEvent = { seq: ev.seq + 1, kind, at: clamp(at), f };
    const head = nextHead(ev.head, event);
    let from = ev.window_from;
    let window: ClockEvidenceEvent[];
    let truncated = ev.truncated;
    if (kind === "responsibility" && this.d.phase !== "overdue" && this.d.phase !== "ended") {
      from = ev.head;
      window = [event];
      truncated = false;
    } else {
      window = [...ev.window, event];
      while (window.length > CLOCK_EVIDENCE_WINDOW) {
        from = nextHead(from, window[0]);
        window = window.slice(1);
        truncated = true;
      }
    }
    this.d.evidence = { seq: event.seq, head, window_from: from, window, truncated };
    this.events.push(event);
    return event;
  }

  done(): ClockStep {
    if (!this.changed) return { record: this.original, events: [], effects: this.effects };
    return { record: { ...this.d, revision: this.original.revision + 1, updated_at: Math.max(this.original.updated_at, this.now) }, events: this.events, effects: this.effects };
  }
}

/** Every timer brought in line with the phase at `at`: the obligation's runs only while active; the cure window only
 *  while a Live overdue stands; nothing runs while paused, system-paused or ended. */
function normalize(x: Draft, at: number): void {
  const d = x.d;
  const live = d.phase !== "ended" && d.phase !== "setup" && d.system === null && d.pause.paused_at === null;
  const ob = d.obligation;
  if (ob !== null && ob.timer !== null) {
    const want = live && d.phase === "active";
    const timer = want ? run(ob.timer, at) : freeze(ob.timer, at);
    if (timer !== ob.timer) {
      d.obligation = { ...ob, timer };
      x.touch();
    }
  }
  const od = d.overdue;
  if (od !== null && od.cure !== null) {
    const want = live && d.phase === "overdue";
    const cure = want ? run(od.cure, at) : freeze(od.cure, at);
    if (cure !== od.cure) {
      d.overdue = { ...od, cure };
      x.touch();
    }
  }
}

/* ==================================================================
    CREATION, POLICY, THE START OF PLAY
   ================================================================== */

export function newClockRecord(input: { readonly gameId: string; readonly deadline: ClockDeadlineClass; readonly paceSecs: number | null; readonly money: boolean; readonly authority: string; readonly now: number }): GameClockRecord {
  const genesis = genesisHead(input.gameId);
  const pace = input.deadline === "async-pace" ? input.paceSecs : null;
  if (input.deadline === "async-pace" && (pace === null || !ASYNC_PACES_SECS.includes(pace))) throw new Error(`an async pace must be one of ${ASYNC_PACES_SECS.join(", ")} seconds`);
  return {
    format: CLOCK_FORMAT,
    version: CLOCK_VERSION,
    game_id: input.gameId,
    revision: 1,
    policy: { class: input.deadline, pace_secs: pace, frozen_at: null },
    money: input.money,
    authority: input.authority,
    trusted_at: input.now,
    watermark: -1,
    seats: [],
    phase: "setup",
    obligation: null,
    parked: [],
    overdue: null,
    strikes: {},
    epochs: 0,
    proposals_total: 0,
    declines: { or_key: null, counts: {} },
    pause: { paused_at: null, request: null, requests: 0, window: { key: null, count: 0 } },
    system: null,
    annul: null,
    undo_floor: -1,
    snapshots: [],
    ended: null,
    remedy: null,
    acks: {},
    evidence: { seq: 0, head: genesis, window_from: genesis, window: [], truncated: false },
    created_at: input.now,
    updated_at: input.now,
  };
}

/** The host's deadline choice before play (an Async table: a pace or No-deadline; a Live table is always Live). */
export function choosePolicy(record: GameClockRecord, deadline: ClockDeadlineClass, paceSecs: number | null, now: number): ClockStep | ClockRefusal {
  if (record.policy.frozen_at !== null || record.phase !== "setup") return { code: "wrong-state", reason: "The table's deadline is fixed once play begins." };
  if (deadline === "async-pace" && (paceSecs === null || !ASYNC_PACES_SECS.includes(paceSecs))) return { code: "bad-frame", reason: "Choose 12 hours, 24 hours, 2 days, 3 days or 7 days." };
  const x = new Draft(record, now);
  x.d.policy = { class: deadline, pace_secs: deadline === "async-pace" ? paceSecs : null, frozen_at: null };
  /* A changed deadline voids earlier No-deadline acknowledgements (each was about THAT disclosure). */
  if (deadline !== record.policy.class) x.d.acks = {};
  x.touch();
  return x.done();
}

/** A No-deadline money table's player acknowledged the disclosure (before the ante). `seated`: the table's seats now
 *  (acknowledgements of seats since vacated are dropped: the record holds at most one per seat). */
export function acknowledge(record: GameClockRecord, seat: string, now: number, seated: readonly string[] = []): ClockStep | ClockRefusal {
  if (record.policy.class !== "no-deadline") return { code: "wrong-state", reason: "This table has a deadline; there is nothing to acknowledge." };
  const keep = new Set([...seated, ...record.seats, seat]);
  const pruned = Object.fromEntries(Object.entries(record.acks).filter(([s]) => keep.has(s)));
  if (record.acks[seat] !== undefined && Object.keys(pruned).length === Object.keys(record.acks).length) return { record, events: [], effects: [] };
  const x = new Draft(record, now);
  x.d.acks = { ...pruned, [seat]: record.acks[seat] ?? now };
  if (record.acks[seat] !== undefined) {
    x.touch();
    return x.done();
  }
  x.emit("ack", now, { seat });
  return x.done();
}

function obligationFor(record: GameClockRecord, decision: RequiredDecision, at: number, beganIndex: number, remaining: number | null, trade: ClockObligation["trade"]): ClockObligation {
  return {
    seat: decision.seat,
    kind: decision.kind,
    key: decision.key,
    began_at: at,
    began_index: beganIndex,
    initial_ms: remaining,
    timer: remaining === null ? null : { remaining_ms: remaining, since: at },
    trade,
  };
}

function emitResponsibility(x: Draft, ob: ClockObligation | null, at: number, cause: { readonly actor: string | null; readonly index: number; readonly reason: string }): void {
  x.emit("responsibility", at, {
    seat: ob?.seat ?? null,
    decision: ob?.kind ?? null,
    key: ob?.key ?? null,
    timer_ms: ob?.timer?.remaining_ms ?? null,
    trade: ob?.trade !== null && ob?.trade !== undefined,
    actor: cause.actor,
    index: cause.index,
    reason: cause.reason,
  });
}

/* ==================================================================
    THE BATCH FOLD (after a commit, inside the committing task)
   ================================================================== */

/** Brings the record in line with one committed batch. */
export function foldBatch(record: GameClockRecord, batch: ClockBatch, now: number): ClockStep {
  const x = new Draft(record, now);
  const d = x.d;
  const at = batch.at;
  d.watermark = Math.max(d.watermark, batch.last);
  d.seats = batch.after.seats.length > 0 ? [...batch.after.seats] : d.seats;
  x.touch();

  if (d.phase === "setup") {
    beginPlay(x, batch);
    return x.done();
  }
  if (d.phase === "ended") return x.done();

  /* The game's own end: nothing is timed any more. */
  if (batch.after.over || batch.after.closed) {
    endGame(x, batch.after.closed && !batch.after.over ? "room-closed" : "game-end", at, null);
    return x.done();
  }

  /* An undo: restore what the undone batch replaced (never a fresh clock). */
  if (batch.msg === "revert" && batch.revertTarget !== null) {
    restoreUndo(x, batch);
    finishFold(x, batch);
    return x.done();
  }

  const R = d.obligation;
  const allowance = allowanceOf(d);
  const fresh = (decision: RequiredDecision | null, reason: string, trade: ClockObligation["trade"] = null, ms: number | null = allowance): void => {
    d.obligation = decision === null ? null : obligationFor(d, decision, at, batch.first, trade !== null ? LIVE_TRADE_MS : ms, trade);
    emitResponsibility(x, d.obligation, at, { actor: batch.actor, index: batch.first, reason });
  };

  /* The snapshot this batch's undo would restore (the obligation as of its stamp, frozen). */
  pushSnapshot(x, batch.first, at, R, d.parked, d.declines);

  /* A CURE: the overdue seat's own accepted REQUIRED action -- a move, or its answer to an offer it owed (never an
     offer of its own, a rescission or a private's optional power: those are not the owed decision). Its strike stays;
     the instance ends; its time starts fresh. Someone else's accepted move that leaves the seat owing nothing (a
     proposer rescinding the offer it owed an answer to) MOOTS the instance the same way. */
  let current: ClockObligation | null = R;
  const od = d.overdue;
  if (d.phase === "overdue" && od !== null) {
    const curedBySeat = batch.actor === od.seat && (batch.msg === "move" || batch.msg === "accept" || batch.msg === "reject");
    const responsibilityLeft = batch.actor !== od.seat && batch.after.decision?.seat !== od.seat;
    if (curedBySeat || responsibilityLeft) {
      x.emit("cure", at, { seat: od.seat, epoch: od.epoch, index: batch.first, by: batch.actor, strike: od.strike });
      d.overdue = null;
      d.phase = "active";
      d.undo_floor = Math.max(d.undo_floor, batch.last);
      if (d.money) x.effects.push({ kind: "fence-checkpoint", epoch: od.epoch });
      if (current !== null && current.seat === od.seat && allowance !== null) {
        current = { ...current, timer: { remaining_ms: allowance, since: at }, initial_ms: allowance, began_at: at };
        d.obligation = current;
      }
    }
  }

  const before = batch.before.offer;
  const after = batch.after.offer;
  const D = batch.after.decision;
  const isLive = d.policy.class === "live";

  if (after !== null && (before === null || before.key !== after.key)) {
    /* A NEW STANDING OFFER. */
    const proposer = after.proposer;
    const answerer = after.answerer;
    if (proposer !== null && answerer !== null && proposer !== answerer && D !== null && D.seat === answerer) {
      if (current !== null && current.seat === proposer && current.timer !== null) {
        d.parked = [...d.parked.filter((p) => p.seat !== proposer), { seat: proposer, offer_key: after.key, remaining_ms: remainingAt(current.timer, at) }];
      }
      if (isLive && after.slot === "train") {
        fresh(D, "train-offer", { proposer, offer_key: after.key });
        x.emit("trade-begin", at, { proposer, recipient: answerer, offer: after.key, index: batch.first, parked_ms: d.parked.find((p) => p.seat === proposer)?.remaining_ms ?? null });
      } else {
        fresh(D, "offer");
      }
    } else if (D !== null && current !== null && D.seat === current.seat) {
      /* An offer to oneself: nothing parks, nothing refreshes (only an accepted trade is progress). */
      d.obligation = { ...current, kind: D.kind, key: D.key };
    } else {
      fresh(D, "offer");
    }
  } else if (before !== null && (after === null || after.key !== before.key)) {
    /* THE STANDING OFFER RESOLVED. */
    const parked = d.parked.find((p) => p.offer_key === before.key) ?? null;
    d.parked = d.parked.filter((p) => p.offer_key !== before.key);
    /* An unanswered expiry is a fence: no undo may resurrect the expired offer. */
    if (batch.msg === "server-expiry") d.undo_floor = Math.max(d.undo_floor, batch.last);
    const selfOffer = before.proposer !== null && before.proposer === before.answerer;
    const trainLive = isLive && before.slot === "train" && !selfOffer;
    if (trainLive && (batch.msg === "reject" || batch.msg === "server-expiry") && before.proposer !== null && before.answerer !== null) {
      bumpDeclines(x, batch.before.orKey, before.proposer, before.answerer);
    }
    if (trainLive) {
      x.emit("trade-end", at, {
        result: batch.msg === "accept" ? "accept" : batch.msg === "reject" ? "reject" : batch.msg === "server-expiry" ? "expire" : batch.msg === "rescind" ? "rescind" : "other",
        proposer: before.proposer,
        recipient: before.answerer,
        offer: before.key,
        index: batch.first,
        declines: before.proposer !== null && before.answerer !== null ? (d.declines.counts[`${before.proposer}>${before.answerer}`] ?? 0) : 0,
      });
    }
    const answered = (batch.msg === "accept" || batch.msg === "reject") && batch.actor === before.answerer;
    if (selfOffer) {
      if (batch.msg === "accept") fresh(D, "accepted");
      else if (D !== null && current !== null && D.seat === current.seat) d.obligation = { ...current, kind: D.kind, key: D.key };
      else fresh(D, "offer-closed");
    } else if (answered) {
      /* The answerer completed its decision: the next one (the proposer's, normally) starts fresh. */
      fresh(D, batch.msg === "accept" ? "offer-accepted" : "offer-rejected");
    } else if (D !== null && parked !== null && D.seat === parked.seat) {
      /* An unanswered expiry, or anything else that closed it: the proposer resumes EXACTLY. A RESCISSION by the proposer
         is charged the time its offer stood (the proposer withdrew rather than wait for the answer): an offer can never
         be used to stop the proposer's own clock. */
      const stood = batch.msg === "rescind" && batch.actor === parked.seat && current !== null && current.key === `offer:${before.key}` ? clamp(at - current.began_at) : 0;
      const resumed = clamp(parked.remaining_ms - stood);
      d.obligation = obligationFor(d, D, at, batch.first, resumed, null);
      d.obligation = { ...d.obligation, initial_ms: resumed };
      emitResponsibility(x, d.obligation, at, { actor: batch.actor, index: batch.first, reason: batch.msg === "server-expiry" ? "offer-expired" : "offer-withdrawn" });
    } else {
      fresh(D, "offer-closed");
    }
  } else {
    /* AN ORDINARY MOVE. */
    if (batch.msg === "optional" && D !== null && current !== null && D.seat === current.seat) {
      /* A private's optional power: not a required decision -- nothing refreshes. */
      if (D.key !== current.key || D.kind !== current.kind) d.obligation = { ...current, kind: D.kind, key: D.key };
    } else if (D === null) {
      if (current !== null) {
        d.obligation = null;
        emitResponsibility(x, null, at, { actor: batch.actor, index: batch.first, reason: "nobody-owes" });
      }
    } else if (current === null || batch.actor === current.seat || D.seat !== current.seat) {
      fresh(D, current !== null && D.seat === current.seat ? "accepted-action" : "handoff");
    } else if (D.key !== current.key || D.kind !== current.kind) {
      d.obligation = { ...current, kind: D.kind, key: D.key };
    }
  }

  finishFold(x, batch);
  return x.done();
}

function finishFold(x: Draft, batch: ClockBatch): void {
  const d = x.d;
  /* The pause-request bound is per obligation: a new obligation starts a new window. */
  const key = d.obligation?.key ?? null;
  if (d.pause.window.key !== key && d.pause.window.count > 0) d.pause = { ...d.pause, window: { key, count: 0 } };
  /* The two-decline limit is the current Operating Round's: a new OR (or leaving the ORs) clears it. */
  const orKey = batch.after.orKey;
  if (d.declines.or_key !== orKey && (Object.keys(d.declines.counts).length > 0 || d.declines.or_key !== null)) {
    d.declines = { or_key: orKey, counts: {} };
  }
  /* Parked clocks of offers no longer standing are dropped (the offer is gone; nothing may resume from it). */
  const standing = batch.after.offer?.key ?? null;
  if (d.parked.some((p) => p.offer_key !== standing)) d.parked = d.parked.filter((p) => p.offer_key === standing);
  normalize(x, batch.at);
}

function bumpDeclines(x: Draft, orKey: string | null, from: string, to: string): void {
  const d = x.d;
  const counts = d.declines.or_key === orKey ? { ...d.declines.counts } : {};
  const key = `${from}>${to}`;
  counts[key] = (counts[key] ?? 0) + 1;
  d.declines = { or_key: orKey, counts };
}

function pushSnapshot(x: Draft, index: number, at: number, obligation: ClockObligation | null, parked: readonly ClockParked[], declines: GameClockRecord["declines"]): void {
  const frozen = obligation === null ? null : { ...obligation, timer: obligation.timer === null ? null : freeze(obligation.timer, at) };
  const kept = x.d.snapshots.filter((snap) => snap.index < index);
  x.d.snapshots = [...kept, { index, at, obligation: frozen, parked: [...parked], declines: { or_key: declines.or_key, counts: { ...declines.counts } } }].slice(-CLOCK_SNAPSHOT_LIMIT);
}

/** Declines never go back: the larger count per direction of two views of the same Operating Round. */
function mergeDeclines(a: GameClockRecord["declines"], b: GameClockRecord["declines"]): GameClockRecord["declines"] {
  if (a.or_key !== b.or_key) return a;
  const counts: Record<string, number> = { ...a.counts };
  for (const [key, count] of Object.entries(b.counts)) counts[key] = Math.max(counts[key] ?? 0, count);
  return { or_key: a.or_key, counts };
}

function restoreUndo(x: Draft, batch: ClockBatch): void {
  const d = x.d;
  const at = batch.at;
  const target = batch.revertTarget as number;
  const current = d.obligation;
  const snap = d.snapshots.find((s) => s.index === target) ?? null;
  const D = batch.after.decision;
  let restored: ClockObligation | null;
  let how: string;
  if (snap !== null && snap.obligation !== null && D !== null && snap.obligation.seat === D.seat) {
    const prior = snap.obligation;
    /* An undo never gives time. When the restored seat held responsibility throughout since the undone batch (one
       act-and-undo, or several of its own steps undone at once), or its clock stood parked behind an offer it made at
       the undone batch, everything since is charged back; otherwise (others held it meanwhile) only its own current run
       that began at the undone batch. */
    const since = d.snapshots.filter((s) => s.index > target);
    const sameSeatThroughout = current !== null && current.seat === prior.seat && since.every((s) => s.obligation !== null && s.obligation.seat === prior.seat);
    const parkedSince = current !== null && current.began_index === target && d.parked.some((p) => p.seat === prior.seat);
    const charge =
      sameSeatThroughout || parkedSince
        ? clamp(at - snap.at)
        : current !== null && current.seat === prior.seat && current.began_index === target && current.initial_ms !== null && current.timer !== null
          ? clamp(current.initial_ms - remainingAt(current.timer, at))
          : 0;
    restored = {
      ...prior,
      kind: D.kind,
      key: D.key,
      began_at: at,
      began_index: prior.began_index,
      timer: prior.timer === null ? null : { remaining_ms: clamp(prior.timer.remaining_ms - charge), since: at },
    };
    d.parked = [...snap.parked];
    how = charge > 0 ? "undo-restored-charged" : "undo-restored";
  } else if (D === null) {
    restored = null;
    how = "undo-nobody-owes";
  } else {
    /* No snapshot (older than the ring, or a recovered gap): never a fresh allowance -- the restored seat continues
       with the time the current clock has left (or, being the same seat, simply continues). */
    const left = current?.timer !== null && current?.timer !== undefined ? remainingAt(current.timer, at) : allowanceOf(d);
    restored = obligationFor(d, D, at, batch.first, left, null);
    how = "undo-unrecorded";
  }
  if (snap !== null && snap.declines.or_key === batch.after.orKey) d.declines = mergeDeclines({ or_key: snap.declines.or_key, counts: { ...snap.declines.counts } }, d.declines);
  d.snapshots = d.snapshots.filter((s) => s.index < target);
  d.obligation = restored;
  x.emit("undo", at, { target, index: batch.first, by: batch.actor, seat: restored?.seat ?? null, remaining_ms: restored?.timer?.remaining_ms ?? null, how });
  emitResponsibility(x, restored, at, { actor: batch.actor, index: batch.first, reason: how });
}

function beginPlay(x: Draft, batch: ClockBatch): void {
  const d = x.d;
  const at = batch.at;
  d.policy = { ...d.policy, frozen_at: at };
  d.phase = "active";
  x.emit("policy", at, { deadline: d.policy.class, pace_secs: d.policy.pace_secs, money: d.money, seats: [...d.seats] });
  const D = batch.after.decision;
  d.obligation = D === null ? null : obligationFor(d, D, at, batch.first, allowanceOf(d), null);
  d.declines = { or_key: batch.after.orKey, counts: {} };
  emitResponsibility(x, d.obligation, at, { actor: batch.actor, index: batch.first, reason: "deal" });
  normalize(x, at);
}

function endGame(x: Draft, kind: ClockEndKind, at: number, seat: string | null): void {
  const d = x.d;
  if (d.phase === "ended") return;
  normalize(x, at);
  d.phase = "ended";
  d.ended = { kind, at, seat };
  d.pause = { ...d.pause, request: null };
  d.annul = null;
  if (d.obligation !== null && d.obligation.timer !== null) d.obligation = { ...d.obligation, timer: freeze(d.obligation.timer, at) };
  if (d.overdue !== null && d.overdue.cure !== null) d.overdue = { ...d.overdue, cure: freeze(d.overdue.cure, at) };
  x.emit("ended", at, { kind, seat });
}

/* ==================================================================
    TIME: OVERDUE, FINALITY, THE TRADE RESPONSE (`advance`)
   ================================================================== */

/** Processes every transition due by `now`, in time order, each AT ITS OWN MOMENT (never at `now`). Stops at a train
 *  offer's expiry: that needs the log (the controller closes the offer, then folds it and advances again). */
export function advance(record: GameClockRecord, now: number, position: LogPosition): ClockStep & { readonly tradeExpiry: Extract<ClockEffect, { kind: "trade-expiry" }> | null } {
  const x = new Draft(record, now);
  const d = x.d;
  for (let guard = 0; guard < 8; guard += 1) {
    if (d.phase !== "active" && d.phase !== "overdue") break;
    if (d.system !== null || d.pause.paused_at !== null) break;
    const ob = d.obligation;
    if (d.phase === "active" && ob !== null && ob.timer !== null) {
      const due = dueOf(ob.timer);
      if (due !== null && due <= now) {
        if (ob.trade !== null) {
          const step = x.done();
          return { ...step, tradeExpiry: { kind: "trade-expiry", at: due, offerKey: ob.trade.offer_key, proposer: ob.trade.proposer, recipient: ob.seat } };
        }
        becomeOverdue(x, due, position);
        continue;
      }
    }
    const od = d.overdue;
    if (d.phase === "overdue" && od !== null && od.cure !== null) {
      const due = dueOf(od.cure);
      if (due !== null && due <= now) {
        finality(x, due);
        continue;
      }
    }
    break;
  }
  return { ...x.done(), tradeExpiry: null };
}

/** When the next transition falls due (ms), or `null` (nothing is counting down). */
export function nextDue(record: GameClockRecord): number | null {
  if (record.phase !== "active" && record.phase !== "overdue") return null;
  if (record.system !== null || record.pause.paused_at !== null) return null;
  if (record.phase === "active") return dueOf(record.obligation?.timer ?? null);
  return dueOf(record.overdue?.cure ?? null);
}

function becomeOverdue(x: Draft, at: number, position: LogPosition): void {
  const d = x.d;
  const ob = d.obligation as ClockObligation;
  const live = d.policy.class === "live";
  const epoch = d.epochs + 1;
  d.epochs = epoch;
  const strike = live ? (d.strikes[ob.seat] ?? 0) + 1 : 0;
  if (live) d.strikes = { ...d.strikes, [ob.seat]: strike };
  const pos = position();
  d.obligation = { ...ob, timer: ob.timer === null ? null : { remaining_ms: 0, since: null } };
  x.emit("overdue", at, { seat: ob.seat, strike, epoch, decision: ob.kind, key: ob.key, log_len: pos.len, log_hash: pos.hash, mode: live ? "live" : "async", allowance_ms: allowanceOf(d) });
  const overdue: ClockOverdue = {
    epoch,
    seat: ob.seat,
    strike,
    at,
    log_len: pos.len,
    log_hash: pos.hash,
    decision_kind: ob.kind,
    cure: live && strike <= LIVE_CURABLE_OVERDUES ? { remaining_ms: LIVE_CURE_MS, since: at } : null,
    proposal: null,
    proposals: 0,
  };
  d.overdue = overdue;
  d.phase = "overdue";
  d.pause = { ...d.pause, request: null };
  if (live && strike > LIVE_CURABLE_OVERDUES) {
    /* THE THIRD ORDINARY EXPIRY: foreclosure at once -- no cure window, no vote, no neutral default. */
    x.emit("final", at, { epoch, seat: ob.seat, outcome: "strike3-foreclosure" });
    if (d.money) seal(x, 3, overdue, at, []);
    endGame(x, "live-strike3-foreclosure", at, ob.seat);
  }
}

function finality(x: Draft, at: number): void {
  const d = x.d;
  const od = d.overdue as ClockOverdue;
  const proposal = od.proposal;
  /* The attestation's own final moment (whole seconds, never earlier than the overdue plus the 10-minute window), and
     the relay's margin past it: an approval that cannot outlive both cannot decide minute 30. */
  const finalSecs = finalSecsOf(od, at);
  const complete = proposal !== null && proposal.kind === "foreclose" && proposal.complete_at !== null;
  const valid = complete && (!d.money || approvalsOutlive((proposal as ClockProposal).votes, finalSecs));
  const foreclose = complete && valid;
  x.emit("final", at, { epoch: od.epoch, seat: od.seat, outcome: foreclose ? "foreclosure" : "timeout-annul", proposal: proposal?.id ?? null, approvals_valid: complete ? valid : null });
  if (d.money) seal(x, foreclose ? 2 : 1, od, at, foreclose ? (proposal as ClockProposal).votes : []);
  endGame(x, foreclose ? "live-foreclosure" : "live-timeout-annul", at, od.seat);
}

/** Live: the minute-30 finality as it stands at `now` (the cure window's due, or -- paused -- now plus what is left). */
export function projectedFinalityMs(record: GameClockRecord, now: number): number | null {
  const od = record.overdue;
  if (od === null || od.cure === null) return null;
  return od.cure.since !== null ? od.cure.since + od.cure.remaining_ms : now + od.cure.remaining_ms;
}

/** The attested final moment (whole seconds) of a Live finality at `finalMs`: never earlier than the overdue plus the
 *  10-minute window. */
export function finalSecsOf(od: Pick<ClockOverdue, "at">, finalMs: number): number {
  return Math.max(secsUpOf(finalMs), secsUpOf(od.at) + LIVE_CURE_MS / 1000);
}

/** Live (money): every YES approval of the complete foreclosure outlives `finalSecs` by the relay's margin. */
function approvalsOutlive(votes: readonly ClockVote[], finalSecs: number): boolean {
  return votes.every((v) => !v.yes || (v.approval !== null && v.approval.approve_until > finalSecs + LIVE_FINALITY_APPROVAL_MARGIN_SECS));
}

/** Live: would minute 30, as it stands now, end the game by foreclosure (a complete N-1 foreclosure whose money
 *  approvals outlive the projected finality)? */
export function liveForeclosureStands(record: GameClockRecord, now: number): boolean {
  const od = record.overdue;
  const proposal = od?.proposal ?? null;
  if (od === null || od.cure === null || proposal === null || proposal.kind !== "foreclose" || proposal.complete_at === null) return false;
  if (!record.money) return true;
  const due = projectedFinalityMs(record, now);
  return due !== null && approvalsOutlive(proposal.votes, finalSecsOf(od, due));
}

/** Seals a money remedy DECISION (the attestation's time-independent part) with its evidence. */
function seal(x: Draft, kind: RemedyKind, od: ClockOverdue, finalMs: number, votes: readonly ClockVote[], replaces: RemedyKind | null = null): void {
  const d = x.d;
  const approvals = votes
    .filter((v) => v.yes && v.approval !== null)
    .map((v) => ({ seat: v.seat, approve_until: (v.approval as { approve_until: number }).approve_until, signature: (v.approval as { signature: string }).signature }))
    .sort((a, b) => (a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : 0));
  const allowanceSecs = allowanceSecsOf(d) ?? 0;
  x.emit("remedy-sealed", finalMs, {
    remedy: kind,
    seat: od.seat,
    strike: od.strike,
    epoch: od.epoch,
    log_len: od.log_len,
    log_hash: od.log_hash,
    allowance_secs: allowanceSecs,
    overdue_ms: od.at,
    final_ms: finalMs,
    approvals: approvals.map((a) => `${a.seat}:${a.approve_until}:${signatureDigest(a.signature)}`),
    replaces,
  });
  const ev = d.evidence;
  d.remedy = {
    kind,
    seat: od.seat,
    strike: od.strike,
    epoch: od.epoch,
    log_len: od.log_len,
    log_hash: od.log_hash,
    allowance_secs: allowanceSecs,
    overdue_ms: od.at,
    final_ms: finalMs,
    approvals,
    evidence: { format: CLOCK_EVIDENCE_FORMAT, game_id: d.game_id, prev_head: ev.window_from, events: [...ev.window], truncated: ev.truncated },
    evidence_hash: ev.head,
    sealed_at: finalMs,
    status: "sealed",
    detail: null,
    attestations: 0,
    replaces,
    stale: [],
  };
  x.effects.push({ kind: "remedy" });
}

/** Money, Live: the sealed foreclosure (remedy 2) can no longer land (an approval's horizon passed while the escrow was
 *  paused or the relay stalled): the server falls back to the NEUTRAL timeout annulment (remedy 1) of the same overdue
 *  instance, final at the same moment. A different decision: FP4's fence makes it wait until the earlier attestation
 *  can no longer land. */
export function sealNeutralFallback(record: GameClockRecord, now: number, why: string): ClockStep | ClockRefusal {
  const r = record.remedy;
  if (r === null || r.kind !== 2 || r.status === "confirmed") return { code: "wrong-state", reason: "There is no foreclosure to fall back from." };
  const x = new Draft(record, now);
  const od: ClockOverdue = { epoch: r.epoch, seat: r.seat, strike: r.strike, at: r.overdue_ms, log_len: r.log_len, log_hash: r.log_hash, decision_kind: "turn", cure: null, proposal: null, proposals: 0 };
  x.emit("remedy-status", now, { remedy: 2, status: "superseded", detail: why.slice(0, 200) });
  seal(x, 1, od, r.final_ms, [], 2);
  return x.done();
}

/** The pipeline's progress on the sealed remedy (`submitted` once attested and handed to FP4, `confirmed` on chain,
 *  `superseded` when the game ended another way, `refused` while it cannot be attested -- fail closed). */
export function remedyProgress(record: GameClockRecord, status: RemedyStatus, detail: string | null, now: number, attested = false): ClockStep {
  const r = record.remedy;
  if (r === null) return { record, events: [], effects: [] };
  if (r.status === status && r.detail === detail && !attested) return { record, events: [], effects: [] };
  const x = new Draft(record, now);
  x.d.remedy = { ...r, status, detail: detail === null ? null : detail.slice(0, 500), attestations: r.attestations + (attested ? 1 : 0) };
  /* The evidence says WHAT happened (a status), never the free text of why (signer, chain or host errors stay in the
     record and the ops lines). */
  if (r.status !== status) x.emit("remedy-status", now, { remedy: r.kind, status });
  else x.touch();
  return x.done();
}

/** Async N-1 remedy (money): the pipeline found approvals that can no longer land (lapsed, or the seat's consent key
 *  moved since it signed). Nothing is attested; each named seat is asked to approve the SAME decision again. */
export function remedyStale(record: GameClockRecord, seats: readonly string[], now: number): ClockStep {
  const r = record.remedy;
  if (r === null || (r.kind !== 4 && r.kind !== 5) || r.status === "confirmed" || r.status === "superseded") return { record, events: [], effects: [] };
  const stale = [...new Set(seats.filter((seat) => r.approvals.some((a) => a.seat === seat)))].sort();
  if (stale.length === 0 || (stale.length === r.stale.length && stale.every((seat, i) => r.stale[i] === seat) && r.status === "refused")) return { record, events: [], effects: [] };
  const x = new Draft(record, now);
  x.d.remedy = { ...r, status: "refused", detail: "approvals must be renewed", stale };
  x.emit("remedy-status", now, { remedy: r.kind, status: "approvals-stale", seats: stale });
  return x.done();
}

/** A seat named stale renews its REMEDY-APPROVE for the sealed Async decision (verified by the caller against its
 *  CURRENT key and these facts). Once none is stale the same decision is sealed again with the renewed approvals -- a
 *  new evidence head, so FP4's fence treats it as a later attestation of the decision. */
export function reapprove(record: GameClockRecord, by: string, approval: NonNullable<ClockVote["approval"]>, now: number): ClockStep | ClockRefusal {
  const r = record.remedy;
  if (r === null || (r.kind !== 4 && r.kind !== 5) || r.status === "confirmed" || r.status === "superseded") return { code: "wrong-state", reason: "There is no outcome waiting for your approval." };
  if (!r.stale.includes(by)) return { code: "wrong-state", reason: "Your approval of this outcome is still valid." };
  const x = new Draft(record, now);
  const approvals = [...r.approvals.filter((a) => a.seat !== by), { seat: by, approve_until: approval.approve_until, signature: approval.signature }].sort((a, b) => (a.seat < b.seat ? -1 : a.seat > b.seat ? 1 : 0));
  const stale = r.stale.filter((seat) => seat !== by);
  x.emit("reapproval", now, { epoch: r.epoch, seat: by, approve_until: approval.approve_until, signature: signatureDigest(approval.signature) });
  if (stale.length > 0) {
    x.d.remedy = { ...r, approvals, stale };
    return x.done();
  }
  /* Every approval renewed: the same decision, sealed again (its evidence now ends at this seal). */
  const od: ClockOverdue = { epoch: r.epoch, seat: r.seat, strike: r.strike, at: r.overdue_ms, log_len: r.log_len, log_hash: r.log_hash, decision_kind: "turn", cure: null, proposal: null, proposals: 0 };
  seal(x, r.kind, od, r.final_ms, approvals.map((a) => ({ seat: a.seat, yes: true, at: now, approval: { approve_until: a.approve_until, signature: a.signature } })), r.replaces);
  x.d.remedy = { ...(x.d.remedy as ClockRemedy), attestations: r.attestations };
  return x.done();
}

/* ==================================================================
    PROPOSALS AND VOTES (N-1)
   ================================================================== */

const others = (record: GameClockRecord, defaulter: string): string[] => record.seats.filter((s) => s !== defaulter);

/** A non-defaulting seat proposes an N-1 remedy (Live: foreclosure only -- the neutral outcome is automatic; Async:
 *  foreclosure or neutral annulment). Proposing is the proposer's own YES. */
export function propose(record: GameClockRecord, by: string, kind: ClockProposalKind, approval: ClockVote["approval"], now: number, stale: readonly string[] = []): ClockStep | ClockRefusal {
  const od = record.overdue;
  if (record.phase !== "overdue" || od === null) return { code: "wrong-state", reason: "Nobody is overdue." };
  if (record.system !== null) return { code: CLOCK_REFUSAL.systemPaused, reason: SYSTEM_PAUSE_SENTENCE };
  if (!record.seats.includes(by) || by === od.seat) return { code: "forbidden", reason: "Only the other seated players can propose this." };
  if (record.policy.class === "live" && kind !== "foreclose") return { code: "bad-frame", reason: "On a Live table the vote is only about foreclosure; the neutral outcome is automatic at minute 30." };
  if (od.proposal !== null) return { code: "wrong-state", reason: "A proposal is already open: vote on it first." };
  if (od.proposals >= CLOCK_PROPOSALS_PER_OVERDUE) return { code: "rate-limited", reason: "Too many proposals for this overdue." };
  if (record.money && approval === null) return { code: "bad-frame", reason: "On a money table, proposing needs your signed approval." };
  const x = new Draft(record, now);
  const id = record.proposals_total + 1;
  x.d.proposals_total = id;
  const proposal: ClockProposal = { id, kind, by, at: now, votes: [{ seat: by, yes: true, at: now, approval }], complete_at: null };
  x.d.overdue = { ...od, proposal, proposals: od.proposals + 1 };
  x.emit("proposal", now, { epoch: od.epoch, id, kind, by });
  x.emit("vote", now, voteFields(od.epoch, id, by, true, approval));
  completeIfUnanimous(x, now, stale);
  return x.done();
}

function voteFields(epoch: number, id: number, seat: string, yes: boolean, approval: ClockVote["approval"]): ClockEvidenceEvent["f"] {
  return { epoch, id, seat, yes, approve_until: approval?.approve_until ?? null, signature: approval === null ? null : signatureDigest(approval.signature) };
}

/** A non-defaulting seat's YES or NO on the standing proposal (bound to its id). A NO vetoes it at once; a YES that
 *  completes the N-1 set records the outcome (Live: pending minute 30; Async: final now). A seat may change its YES to a
 *  NO before finality (a veto); a repeated identical vote changes nothing. */
export function vote(
  record: GameClockRecord,
  by: string,
  proposalId: number,
  yes: boolean,
  approval: ClockVote["approval"],
  now: number,
  options: { readonly kind?: ClockProposalKind | null; readonly stale?: readonly string[] } = {},
): ClockStep | ClockRefusal {
  const od = record.overdue;
  if (record.phase !== "overdue" || od === null) return { code: "wrong-state", reason: "Nobody is overdue." };
  if (record.system !== null) return { code: CLOCK_REFUSAL.systemPaused, reason: SYSTEM_PAUSE_SENTENCE };
  const proposal = od.proposal;
  if (proposal === null || proposal.id !== proposalId) return { code: CLOCK_REFUSAL.stale, reason: "That proposal is no longer open." };
  /* A money YES's approval was checked for ONE kind of remedy: it never counts toward a proposal of the other kind. */
  if (options.kind !== undefined && options.kind !== null && options.kind !== proposal.kind) return { code: CLOCK_REFUSAL.stale, reason: "That proposal is no longer open." };
  if (!record.seats.includes(by) || by === od.seat) return { code: "forbidden", reason: "Only the other seated players vote on this." };
  if (yes && record.money && approval === null) return { code: "bad-frame", reason: "On a money table, a YES needs your signed approval." };
  const prior = proposal.votes.find((v) => v.seat === by) ?? null;
  if (prior !== null && prior.yes === yes && (!yes || (prior.approval?.approve_until === approval?.approve_until && prior.approval?.signature === approval?.signature))) return { record, events: [], effects: [] };
  const x = new Draft(record, now);
  if (!yes) {
    x.emit("vote", now, voteFields(od.epoch, proposal.id, by, false, null));
    x.emit("veto", now, { epoch: od.epoch, id: proposal.id, by });
    x.d.overdue = { ...od, proposal: null };
    return x.done();
  }
  const votes = [...proposal.votes.filter((v) => v.seat !== by), { seat: by, yes: true, at: now, approval }].sort((a, b) => (a.seat < b.seat ? -1 : 1));
  x.d.overdue = { ...od, proposal: { ...proposal, votes } };
  x.emit("vote", now, voteFields(od.epoch, proposal.id, by, true, approval));
  completeIfUnanimous(x, now, options.stale ?? []);
  return x.done();
}

/** Completes the N-1 set when every non-defaulting seat's YES is in. On a money table a YES counts only while its
 *  approval can still land: an Async one must outlive the completion by `ASYNC_COMPLETION_APPROVAL_MARGIN_SECS`, and
 *  none whose seat's consent key moved since it signed (`stale`, found by the caller's chain read) -- those YES votes are
 *  set aside (evidence: `vote-stale`) and the seat is asked again; nothing is sealed on an approval that cannot land. */
function completeIfUnanimous(x: Draft, now: number, stale: readonly string[] = []): void {
  const d = x.d;
  let od = d.overdue as ClockOverdue;
  let proposal = od.proposal as ClockProposal;
  if (proposal.complete_at !== null) return;
  if (d.money) {
    const horizon = secsDownOf(now) + (d.policy.class === "async-pace" ? ASYNC_COMPLETION_APPROVAL_MARGIN_SECS : 0);
    const lapsed = proposal.votes.filter((v) => v.yes && (stale.includes(v.seat) || (d.policy.class === "async-pace" && (v.approval === null || v.approval.approve_until <= horizon))));
    if (lapsed.length > 0) {
      for (const v of lapsed) x.emit("vote-stale", now, { epoch: od.epoch, id: proposal.id, seat: v.seat, reason: stale.includes(v.seat) ? "key-moved" : "lapsed" });
      proposal = { ...proposal, votes: proposal.votes.filter((v) => !lapsed.includes(v)) };
      od = { ...od, proposal };
      d.overdue = od;
    }
  }
  const needed = others(d, od.seat);
  const yes = new Set(proposal.votes.filter((v) => v.yes).map((v) => v.seat));
  if (needed.length === 0 || !needed.every((s) => yes.has(s))) return;
  const done = { ...proposal, complete_at: now };
  d.overdue = { ...od, proposal: done };
  x.emit("consensus", now, { epoch: od.epoch, id: proposal.id, kind: proposal.kind });
  if (d.policy.class === "async-pace") {
    /* Async: complete N-1 consensus is FINAL at once (no grace timer). */
    x.emit("final", now, { epoch: od.epoch, seat: od.seat, outcome: proposal.kind === "foreclose" ? "foreclosure" : "annulment" });
    if (d.money) seal(x, proposal.kind === "foreclose" ? 5 : 4, { ...od, proposal: done }, now, done.votes);
    endGame(x, proposal.kind === "foreclose" ? "async-foreclosure" : "async-annul", now, od.seat);
  }
}

/* ==================================================================
    VOLUNTARY PAUSE (Live): UNANIMOUS TO BEGIN, UNANIMOUS TO END
   ================================================================== */

export function pauseOp(record: GameClockRecord, by: string, op: { readonly action: "request" | "yes" | "no"; readonly kind: "pause" | "resume"; readonly id: number | null }, now: number): ClockStep | ClockRefusal {
  if (record.policy.class !== "live") return { code: "wrong-state", reason: "Only a Live table pauses." };
  if (record.phase !== "active" && record.phase !== "overdue") return { code: "wrong-state", reason: "There is nothing to pause." };
  if (record.system !== null) return { code: CLOCK_REFUSAL.systemPaused, reason: `${SYSTEM_PAUSE_SENTENCE} ${SYSTEM_PAUSE_RESUME_SENTENCE}` };
  if (!record.seats.includes(by)) return { code: "forbidden", reason: "Only a seated player can do that." };
  const paused = record.pause.paused_at !== null;
  if (op.kind === "pause" && paused) return { code: "wrong-state", reason: "The game is already paused." };
  if (op.kind === "resume" && !paused) return { code: "wrong-state", reason: "The game is not paused." };
  const request = record.pause.request;
  const x = new Draft(record, now);
  const d = x.d;
  if (op.action === "request") {
    if (request !== null) {
      if (request.kind !== op.kind) return { code: "wrong-state", reason: "Another request is open: answer it first." };
      return voteOnRequest(x, by, true, now);
    }
    /* PAUSE requests are bounded per obligation (a new obligation opens a new window); a RESUME request never is -- a
       paused table must always be able to ask to resume. */
    let window = record.pause.window;
    if (op.kind === "pause") {
      const key = record.obligation?.key ?? null;
      const used = window.key === key ? window.count : 0;
      if (used >= CLOCK_PAUSE_REQUESTS_PER_OBLIGATION) return { code: "rate-limited", reason: "Too many pause requests for this action. Ask again after the next move." };
      window = { key, count: used + 1 };
    }
    const id = record.pause.requests + 1;
    d.pause = { ...d.pause, requests: id, window, request: { id, kind: op.kind, by, at: now, yes: [by] } };
    x.emit("pause-request", now, { id, kind: op.kind, by });
    applyIfUnanimous(x, now);
    return x.done();
  }
  if (request === null || request.id !== op.id || request.kind !== op.kind) return { code: CLOCK_REFUSAL.stale, reason: "That request is no longer open." };
  return voteOnRequest(x, by, op.action === "yes", now);
}

function voteOnRequest(x: Draft, by: string, yes: boolean, now: number): ClockStep {
  const d = x.d;
  const request = d.pause.request as NonNullable<GameClockRecord["pause"]["request"]>;
  if (!yes) {
    x.emit("pause-cancel", now, { id: request.id, kind: request.kind, by });
    d.pause = { ...d.pause, request: null };
    return x.done();
  }
  if (request.yes.includes(by)) return x.done();
  d.pause = { ...d.pause, request: { ...request, yes: [...request.yes, by].sort() } };
  x.emit("pause-vote", now, { id: request.id, kind: request.kind, by });
  applyIfUnanimous(x, now);
  return x.done();
}

function applyIfUnanimous(x: Draft, now: number): void {
  const d = x.d;
  const request = d.pause.request;
  if (request === null || !d.seats.every((s) => request.yes.includes(s))) return;
  /* A pause and a resume are fences: no undo reaches back across them. */
  d.undo_floor = Math.max(d.undo_floor, d.watermark);
  if (request.kind === "pause") {
    normalize(x, now); // charge what ran up to now, exactly
    d.pause = { ...d.pause, paused_at: now, request: null };
    normalize(x, now); // and freeze it
    x.emit("paused", now, { id: request.id });
  } else {
    d.pause = { ...d.pause, paused_at: null, request: null };
    normalize(x, now); // re-anchored: the exact remainder runs on from now
    x.emit("resumed", now, { id: request.id });
  }
}

/* ==================================================================
    CONTINUITY: SYSTEM PAUSE (Live), OUTAGE CREDIT (Async), THE RECOVERED GAP
   ================================================================== */

/** The authority this process holds took a record another authority wrote (a restart, a takeover, a failover): the
 *  continuity between them is NOT proven. Live: SYSTEM PAUSE (no vote to enter, unanimous to leave), every timer
 *  frozen as of `preservedAt` -- the last instant the earlier authority proved it was in control -- and every
 *  not-yet-final vote staled. Timed Async: the outage is credited (the timers resume, as of `preservedAt`, from now).
 *  No-deadline: nothing is timed. A Live game already ENDED stays ended; if its sealed money remedy is not final on chain
 *  it is SYSTEM-PAUSED too (the owner's rule: on recovery, before signing a remedy, system pause; anything not final on
 *  chain stays frozen until every player resumes) -- nothing is attested or relayed until then. (Residual, recorded:
 *  the defaulting seat can withhold its resume; the contract's exceptional review is the backstop.) Decisions are
 *  never made ACROSS a break: the timers of a running game are frozen as of the last proven instant, and a stall inside
 *  one process is a break too (`clockController.ts`, `CLOCK_CONTINUITY_GAP_*`). */
export function continuityBreak(record: GameClockRecord, input: { readonly now: number; readonly preservedAt: number; readonly reason: string; readonly authority: string }): ClockStep {
  const x = new Draft(record, input.now);
  const d = x.d;
  const preserved = Math.min(Math.max(input.preservedAt, 0), input.now);
  if (d.phase === "setup") {
    x.touch();
    return x.done();
  }
  const timed = d.policy.class === "live" && (d.phase !== "ended" || (d.remedy !== null && d.remedy.status !== "confirmed" && d.remedy.status !== "superseded"));
  if (timed) {
    if (d.system !== null) {
      /* Already system-paused (a second break before anyone resumed): keep the first preserved state; votes restart, and
         a YES must name this break (`since`). */
      d.system = { ...d.system, since: Math.max(input.now, d.system.since + 1), yes: [], reason: input.reason.slice(0, 300) };
      x.emit("system-pause", input.now, { preserved_at: d.system.preserved_at, reason: input.reason.slice(0, 200), again: true });
      return x.done();
    }
    normalize(x, preserved);
    d.system = { since: input.now, preserved_at: preserved, reason: input.reason.slice(0, 300), yes: [] };
    /* A system pause is a fence: no undo reaches back across a continuity break. */
    d.undo_floor = Math.max(d.undo_floor, d.watermark);
    if (d.overdue !== null && d.overdue.proposal !== null && d.phase === "overdue") {
      /* Approvals collected before the break are staled: a decision is never built from votes that crossed it. */
      x.emit("veto", input.now, { epoch: d.overdue.epoch, id: d.overdue.proposal.id, by: "system", stale: true });
      d.overdue = { ...d.overdue, proposal: null };
    }
    d.pause = { ...d.pause, request: null };
    normalize(x, preserved);
    x.emit("system-pause", input.now, { preserved_at: preserved, reason: input.reason.slice(0, 200), again: false });
    return x.done();
  }
  if (d.policy.class === "async-pace" && d.phase !== "ended") {
    /* The outage is never charged: every timer as of `preserved`, running on from now. */
    const ob = d.obligation;
    if (ob !== null && ob.timer !== null && ob.timer.since !== null) d.obligation = { ...ob, timer: { remaining_ms: remainingAt(ob.timer, preserved), since: input.now } };
    x.emit("outage-credited", input.now, { preserved_at: preserved, credited_ms: input.now - preserved });
    return x.done();
  }
  x.touch();
  return x.done();
}

/** A seated player's YES to leave the system pause; unanimity resumes every preserved timer from now. */
export function systemResumeVote(record: GameClockRecord, by: string, now: number, since: number | null = null): ClockStep | ClockRefusal {
  const sys = record.system;
  if (sys === null) return { code: "wrong-state", reason: "The game is not paused by the server." };
  if (!record.seats.includes(by)) return { code: "forbidden", reason: "Only a seated player can do that." };
  /* A YES is for the break the player saw: a later break (its own `since`) needs a fresh look at the preserved timers. */
  if (since !== null && since !== sys.since) return { code: CLOCK_REFUSAL.stale, reason: "The server paused the game again since you looked: check the preserved timer and agree again." };
  if (sys.yes.includes(by)) return { record, events: [], effects: [] };
  const x = new Draft(record, now);
  const d = x.d;
  const yes = [...sys.yes, by].sort();
  x.emit("system-resume-vote", now, { by });
  if (d.seats.every((s) => yes.includes(s))) {
    d.system = null;
    normalize(x, now);
    x.emit("system-resumed", now, { since: sys.since, preserved_at: sys.preserved_at });
  } else {
    d.system = { ...sys, yes };
  }
  return x.done();
}

/** The log moved past what the record folded (the last batch committed, its clock write did not land, and the process
 *  that made it is gone): the obligation is re-derived from the board at the newest entry's stamp, never from a guess
 *  about the gap, and no undo may reach into it. NEVER A FRESH ALLOWANCE FROM A GAP: a seat that still owes and did
 *  not act in it (`actors`: the seats whose gap entries were REQUIRED actions -- a move or an answer) continues on its
 *  own clock; a proposer whose offer still stands keeps its parked remainder; the same train offer keeps its response
 *  time; a seat with a parked remainder from a closed offer resumes that remainder. An overdue seat that made a
 *  required action in the gap cured; one that no longer owes anything is mooted. */
export function recoverGap(record: GameClockRecord, input: { readonly now: number; readonly lastIndex: number; readonly lastAt: number; readonly actors: readonly string[]; readonly facts: ClockBoardFacts }): ClockStep {
  const x = new Draft(record, input.now);
  const d = x.d;
  if (d.phase === "setup" || input.lastIndex <= d.watermark) return x.done();
  const at = Math.max(input.lastAt, d.trusted_at);
  d.watermark = input.lastIndex;
  d.undo_floor = Math.max(d.undo_floor, input.lastIndex);
  d.snapshots = [];
  if (input.facts.seats.length > 0) d.seats = [...input.facts.seats];
  x.touch();
  if (d.phase === "ended") return x.done();
  if (input.facts.over || input.facts.closed) {
    endGame(x, input.facts.closed && !input.facts.over ? "room-closed" : "game-end", at, null);
    return x.done();
  }
  const od = d.overdue;
  let cured: string | null = null;
  if (d.phase === "overdue" && od !== null && (input.actors.includes(od.seat) || input.facts.decision?.seat !== od.seat)) {
    x.emit("cure", at, { seat: od.seat, epoch: od.epoch, index: input.lastIndex, by: "recovered-gap", strike: od.strike });
    d.overdue = null;
    d.phase = "active";
    cured = od.seat;
    if (d.money) x.effects.push({ kind: "fence-checkpoint", epoch: od.epoch });
  }
  if (d.phase === "overdue") {
    normalize(x, at);
    return x.done();
  }
  const D = input.facts.decision;
  const offer = input.facts.offer;
  const prior = d.obligation;
  const allowance = allowanceOf(d);
  const keptParked = d.parked;
  d.parked = [];
  if (D === null) {
    d.obligation = null;
  } else {
    const standing = offer !== null && offer.proposer !== null && offer.answerer === D.seat && offer.proposer !== D.seat ? offer : null;
    if (standing !== null && standing.proposer !== null) {
      const kept = keptParked.find((p) => p.offer_key === standing.key && p.seat === standing.proposer) ?? null;
      const parkedMs = kept !== null ? kept.remaining_ms : prior !== null && prior.seat === standing.proposer && prior.timer !== null ? remainingAt(prior.timer, at) : (allowance ?? 0);
      if (allowance !== null) d.parked = [{ seat: standing.proposer, offer_key: standing.key, remaining_ms: parkedMs }];
    }
    const trade = d.policy.class === "live" && standing !== null && standing.slot === "train" && standing.proposer !== null ? { proposer: standing.proposer, offer_key: standing.key } : null;
    const continues = prior !== null && prior.seat === D.seat && !input.actors.includes(D.seat) && cured !== D.seat && (prior.trade?.offer_key ?? null) === (trade?.offer_key ?? null);
    if (continues && prior !== null) {
      d.obligation = { ...prior, kind: D.kind, key: D.key, timer: prior.timer === null ? null : { remaining_ms: remainingAt(prior.timer, at), since: at } };
    } else {
      const resumed = trade === null && cured !== D.seat ? (keptParked.find((p) => p.seat === D.seat && p.offer_key !== standing?.key) ?? null) : null;
      d.obligation = obligationFor(d, D, at, input.lastIndex, trade !== null ? LIVE_TRADE_MS : resumed !== null && allowance !== null ? resumed.remaining_ms : allowance, trade);
    }
  }
  d.declines = d.declines.or_key === input.facts.orKey ? d.declines : { or_key: input.facts.orKey, counts: {} };
  emitResponsibility(x, d.obligation, at, { actor: null, index: input.lastIndex, reason: "recovered-gap" });
  normalize(x, at);
  return x.done();
}

/** The continuity token and trust instant, stamped on every write by the authority writing it. */
export function stampAuthority(record: GameClockRecord, authority: string, trustedAt: number): GameClockRecord {
  return { ...record, authority, trusted_at: Math.max(record.trusted_at, trustedAt) };
}

/* ==================================================================
    UNANIMOUS NEUTRAL ANNULMENT (a free table's; a money table's runs through its escrow), THE ESCROW'S END
   ================================================================== */

export function annulVote(record: GameClockRecord, by: string, yes: boolean, now: number): ClockStep | ClockRefusal {
  if (record.money) return { code: "wrong-state", reason: "A money table is annulled through its escrow: use Annul game in the money panel." };
  if (record.phase !== "active" && record.phase !== "overdue") return { code: "wrong-state", reason: "There is nothing to annul." };
  if (!record.seats.includes(by)) return { code: "forbidden", reason: "Only a seated player can do that." };
  const x = new Draft(record, now);
  const d = x.d;
  if (!yes) {
    if (d.annul === null) return { record, events: [], effects: [] };
    d.annul = null;
    x.emit("annul-vote", now, { by, yes: false });
    return x.done();
  }
  const current = d.annul?.yes ?? [];
  if (current.includes(by)) return { record, events: [], effects: [] };
  const yesSet = [...current, by].sort();
  d.annul = { yes: yesSet, at: d.annul?.at ?? now };
  x.emit("annul-vote", now, { by, yes: true });
  if (d.seats.every((s) => yesSet.includes(s))) endGame(x, "annulled", now, null);
  return x.done();
}

/** The escrow is terminal on chain (an annulment, a remedy, a review, the game's settlement): gameplay ends. (A sealed
 *  remedy's own status follows its FP4 intent, not this.) */
export function escrowEnded(record: GameClockRecord, at: number, route: string): ClockStep {
  if (record.phase === "ended" || record.phase === "setup") return { record, events: [], effects: [] };
  const x = new Draft(record, at);
  x.emit("remedy-status", at, { remedy: 0, status: "escrow-terminal", detail: route.slice(0, 100) });
  endGame(x, "escrow-ended", at, null);
  return x.done();
}

/** Continuity proven (a heartbeat, or any write by the same authority): the trust instant moves on. */
export function heartbeat(record: GameClockRecord, authority: string, now: number): GameClockRecord {
  return { ...record, revision: record.revision + 1, authority, trusted_at: Math.max(record.trusted_at, now), updated_at: Math.max(record.updated_at, now) };
}

/* ==================================================================
    THE GATE (asked inside the submit task, after `advance`)
   ================================================================== */

export interface GateInput {
  readonly actor: string;
  /** The message's class (`ClockMsgClass` of the submitted message). */
  readonly msg: ClockMsgClass;
  /** `CloseRoom`: the room's own exit is never held by the clock. */
  readonly closeRoom: boolean;
  readonly revertTarget: number | null;
  /** A Live train proposal: the recipient (the seller's president, re-derived from the board). */
  readonly trainRecipient: string | null;
  /** Names, for the owner's copy. */
  readonly nameOf: (seat: string) => string;
}

export function gate(record: GameClockRecord, input: GateInput): ClockRefusal | null {
  if (record.phase === "setup" || input.closeRoom) return null;
  if (record.phase === "ended") return { code: CLOCK_REFUSAL.ended, reason: endedSentence(record) };
  if (record.system !== null) return { code: CLOCK_REFUSAL.systemPaused, reason: `${SYSTEM_PAUSE_SENTENCE} ${SYSTEM_PAUSE_RESUME_SENTENCE}` };
  if (record.pause.paused_at !== null) return { code: CLOCK_REFUSAL.paused, reason: "The game is paused. All players must agree to resume." };
  if (input.msg === "revert") {
    if (record.phase === "overdue") return { code: CLOCK_REFUSAL.undoFence, reason: "Undo is not available while a player is overdue." };
    if (input.revertTarget !== null && input.revertTarget <= record.undo_floor) return { code: CLOCK_REFUSAL.undoFence, reason: "That action cannot be undone: the game clock has moved on past it." };
  }
  const od = record.overdue;
  if (record.phase === "overdue" && od !== null && od.cure !== null && input.actor !== od.seat) {
    return { code: CLOCK_REFUSAL.interrupted, reason: `Play is interrupted: ${input.nameOf(od.seat)} is overdue. Only their owed action continues the game.` };
  }
  /* An overdue seat's own offer is not its owed action: it can neither cure the overdue nor hand the clock to someone
     else while the overdue stands. */
  if (record.phase === "overdue" && od !== null && input.actor === od.seat && input.msg === "propose") {
    return { code: CLOCK_REFUSAL.interrupted, reason: "You're overdue: make your owed move first. An offer can't cure an overdue." };
  }
  if (record.policy.class === "live" && input.msg === "propose" && input.trainRecipient !== null && input.trainRecipient !== input.actor) {
    const count = record.declines.counts[`${input.actor}>${input.trainRecipient}`] ?? 0;
    if (count >= LIVE_DECLINES_PER_OR) return { code: CLOCK_REFUSAL.declines, reason: declinesReachedSentence(input.nameOf(input.trainRecipient)) };
  }
  return null;
}

export function endedSentence(record: GameClockRecord): string {
  const ended = record.ended;
  switch (ended?.kind) {
    case "live-strike3-foreclosure":
      return "The game ended by foreclosure: a third action-clock expiry.";
    case "live-foreclosure":
      return "The game ended by foreclosure after an uncured overdue.";
    case "live-timeout-annul":
      return "The game ended by neutral annulment after an uncured overdue.";
    case "async-annul":
      return "The game ended by neutral annulment (the other players agreed).";
    case "async-foreclosure":
      return "The game ended by foreclosure (the other players agreed).";
    case "annulled":
      return "The game was annulled by every player.";
    case "escrow-ended":
      return "This game's escrow has ended; no more moves can be made.";
    default:
      return "The game is over. Nothing further can be played.";
  }
}

/** Live: the warnings a strike count earns (presentation). */
export function strikeWarning(strikes: number): string | null {
  if (strikes >= LIVE_CURABLE_OVERDUES) return STRIKE_TWO_WARNING;
  if (strikes === 1) return "1 of 2 overdue cures used";
  return null;
}

/* ==================================================================
    THE PROJECTION (`RoomView.clock`)
   ================================================================== */

export function clockViewOf(record: GameClockRecord, now: number): RoomClockView {
  const timerView = (timer: ClockTimer | null) => (timer === null ? null : { remainingMs: remainingAt(timer, now), running: timer.since !== null });
  const ob = record.obligation;
  const od = record.overdue;
  let state: RoomClockView["state"];
  if (record.phase === "setup") state = "setup";
  else if (record.phase === "ended") state = "ended";
  else if (record.system !== null) state = "system-paused";
  else if (record.pause.paused_at !== null) state = "paused";
  else if (record.phase === "overdue") state = "overdue";
  else if (ob?.trade) state = "trade";
  else state = "running";
  const parked = ob?.trade ? (record.parked.find((p) => p.seat === ob.trade?.proposer)?.remaining_ms ?? 0) : 0;
  const proposal = od?.proposal ?? null;
  const needed = od === null ? [] : others(record, od.seat);
  return {
    v: 2,
    deadline: record.policy.class,
    paceSecs: record.policy.pace_secs,
    policyFrozen: record.policy.frozen_at !== null,
    money: record.money,
    state,
    serverNow: now,
    revision: record.revision,
    responsible: ob === null || record.phase === "ended" ? null : { seat: ob.seat, kind: ob.kind },
    action: ob === null || ob.trade !== null || record.phase === "ended" ? null : timerView(ob.timer),
    trade: ob?.trade && record.phase !== "ended" ? { proposer: ob.trade.proposer, recipient: ob.seat, respond: timerView(ob.timer) ?? { remainingMs: 0, running: false }, proposerRemainingMs: parked } : null,
    overdue:
      od === null || record.phase !== "overdue"
        ? null
        : {
            seat: od.seat,
            strike: od.strike,
            epoch: od.epoch,
            overdueAt: od.at,
            logLen: od.log_len,
            logHash: od.log_hash,
            finality: timerView(od.cure),
            outcomeIfUncured: od.cure === null ? null : liveForeclosureStands(record, now) ? "foreclosure" : "timeout-annul",
            cure: od.decision_kind,
            proposal:
              proposal === null
                ? null
                : {
                    id: proposal.id,
                    kind: proposal.kind,
                    by: proposal.by,
                    yes: proposal.votes.filter((v) => v.yes).map((v) => v.seat),
                    no: proposal.votes.filter((v) => !v.yes).map((v) => v.seat),
                    needed,
                    complete: proposal.complete_at !== null,
                  },
          },
    strikes: { ...record.strikes },
    pause: {
      paused: record.pause.paused_at !== null,
      request: record.pause.request === null ? null : { kind: record.pause.request.kind, id: record.pause.request.id, by: record.pause.request.by, yes: [...record.pause.request.yes], needed: [...record.seats] },
    },
    system: record.system === null ? null : { since: record.system.since, preservedAt: record.system.preserved_at, yes: [...record.system.yes], needed: [...record.seats] },
    ended: record.ended === null ? null : { kind: record.ended.kind, at: record.ended.at, seat: record.ended.seat },
    remedy:
      record.remedy === null
        ? null
        : {
            kind: record.remedy.kind,
            status: record.remedy.status,
            stale: [...record.remedy.stale],
            overdue: { seat: record.remedy.seat, strike: record.remedy.strike, epoch: record.remedy.epoch, overdueAt: record.remedy.overdue_ms, logLen: record.remedy.log_len, logHash: record.remedy.log_hash },
          },
    declines: Object.entries(record.declines.counts).map(([key, count]) => {
      const [from, to] = key.split(">");
      return { from, to, count };
    }),
    annul: record.annul === null ? null : { yes: [...record.annul.yes], needed: [...record.seats] },
    noDeadlineAcks: Object.keys(record.acks).sort(),
    seats: [...record.seats],
  };
}

/** The obligation kind a message class closes, for tests and diagnostics. */
export const OFFER_MSG_CLASSES: Readonly<Record<string, ClockMsgClass>> = Object.freeze({
  ProposeTrainPurchase: "propose",
  ProposePrivatePurchase: "propose",
  ProposePrivateTrade: "propose",
  OfferPrivateForFunding: "propose",
  RescindTrainPurchase: "rescind",
  RescindPrivatePurchase: "rescind",
  RescindPrivateTrade: "rescind",
  RescindFundingPrivateOffer: "rescind",
});

/** The clock's class of a logged message (its first key). */
export function classifyMessage(msg: unknown): { readonly cls: ClockMsgClass; readonly revertTarget: number | null; readonly closeRoom: boolean } {
  if (typeof msg !== "object" || msg === null) return { cls: "move", revertTarget: null, closeRoom: false };
  const key = Object.keys(msg as Record<string, unknown>)[0] ?? "";
  const body = (msg as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
  if (key === "RevertTo") return { cls: "revert", revertTarget: typeof body?.index === "number" ? body.index : null, closeRoom: false };
  if (key === "SetupGame") return { cls: "deal", revertTarget: null, closeRoom: false };
  if (key === "CloseRoom") return { cls: "move", revertTarget: null, closeRoom: true };
  if (key === "AnswerTrainPurchase" || key === "AnswerPrivatePurchase" || key === "AnswerPrivateTrade" || key === "AnswerFundingPrivateOffer") {
    return { cls: body?.accept === true ? "accept" : "reject", revertTarget: null, closeRoom: false };
  }
  /* The Mohawk & Hudson's exchange is its owner's own right at any time, never a REQUIRED decision. */
  if (key === "ExchangePrivate") return { cls: "optional", revertTarget: null, closeRoom: false };
  return { cls: OFFER_MSG_CLASSES[key] ?? "move", revertTarget: null, closeRoom: false };
}

/** A logged message whose acceptance is a REQUIRED action (cures an overdue; refreshes the actor's clock). */
export function isRequiredClass(cls: ClockMsgClass): boolean {
  return cls === "move" || cls === "accept" || cls === "reject";
}

export type { RequiredDecisionKind };
