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
// -- a QUALIFYING offer: it suspends the proposer's own required action -- PARKS the proposer's remaining time and puts
// the answer on the answerer. LIVE: the answerer gets the distinct 10:00 RESPONSE timer (never an action clock, never an
// overdue timer) -- the owner's train rule, generalised by the owner (2026-10-06) to every inter-player offer that puts
// its proposer in a waiting state (a Live train offer is always answered on it). The proposer's park is FROZEN only
// within its required-action episode's FREEZE BUDGET (owner ruling, 2026-10-07): each fresh Live required-action
// episode includes at most 10 minutes TOTAL of optional inter-player offer freeze protection, cumulative across every
// qualifying offer while that same action is owed; the answer's wait (the response timer's run: pauses and outages
// consume nothing) is frozen up to what is left of it and CHARGED to the proposer beyond it. Once it is used up, further
// offers stay legal but the proposer's clock keeps running; if it runs out while the offer waits, the server closes the
// offer at that moment and the proposer is overdue (the answerer never is). Whatever closes the offer -- acceptance,
// rejection, unanswered expiry, counter, rescission -- a proposer still owing the same decision resumes its remainder
// (less any charged wait) with the budget left; only a new episode (a fresh 20:00: the required action done, or a
// genuine handoff) renews it. LIVE ONLY: a rejection or an unanswered expiry of a qualifying offer counts one DECLINE
// for that direction (one counter per direction, whatever the kind) in the current ROUND INSTANCE (one operating
// sub-round, one Stock Round); two block a third qualifying offer in that direction until the next round instance (the
// reverse direction and other players stay open); the freeze budget is independent of it. TIMED ASYNC: the park keeps
// RUNNING (no freeze, no response timer, no decline count); No-deadline: nothing is timed. No count of offers per round
// and no history length ever limits an offer (offer churn is bounded by the transport's frequency limit,
// `gameServer.ts`). An offer that suspends nothing of its proposer's (to oneself, or made TO the responsible player)
// parks nothing and refreshes nothing until it is accepted.
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
// exactly, for as long as it lasts. A SYSTEM PAUSE (a continuity break while the game is still PLAYABLE) is entered by
// the server with no vote, freezes every timer at the last instant continuity was proven, stales any not-yet-final
// votes, and needs every seated player's YES to end. Outage time is never charged: it never creates an overdue, a
// strike, a finality or an expiry. Once the game has ENDED (its remedy sealed) there is nothing to resume: a break
// pauses nothing and no vote gates the sealed remedy, which the controller carries on unchanged (owner, 2026-10-06).
//
// UNDO. A standing undo restores the obligation the undone batch replaced, from the snapshot taken before it -- never
// a fresh allowance -- and charges any time the current run had already used if that run began at the undone batch
// (an act-and-undo can never extend a clock). No undo reaches at or before a fence (`undo_floor`: a cure, an expiry, a
// pause, a system pause, a recovered gap); none is taken while a seat is overdue; declines and strikes never go back.

import type { RequiredDecision, RequiredDecisionKind, StandingOffer } from "../../../../frontend/src/gameEngine/clockResponsibility";
import type { ClockDeadlineClass, ClockEndKind, ClockProposalKind, RoomClockView } from "../../../../frontend/src/utils/clockProtocol";
import { CLOCK_REFUSAL, declinesReachedSentence, STRIKE_TWO_WARNING, SYSTEM_PAUSE_RESUME_SENTENCE, SYSTEM_PAUSE_SENTENCE } from "../../../../frontend/src/utils/clockProtocol";
import { genesisHead, ledgerGenesisHead, nextHead, signatureDigest, CLOCK_EVIDENCE_FORMAT, type ClockEvidenceEvent, type ClockEvidenceKind } from "./clockEvidence";
import {
  ASYNC_PACES_SECS,
  CLOCK_EVIDENCE_WINDOW,
  CLOCK_FORMAT,
  CLOCK_LEDGER_LIMIT,
  CLOCK_RESUME_BURST,
  CLOCK_RESUME_SPACING_MS,
  CLOCK_PAUSE_REQUESTS_PER_OBLIGATION,
  CLOCK_PROPOSALS_PER_OVERDUE,
  CLOCK_SNAPSHOT_LIMIT,
  CLOCK_VERSION,
  LIVE_ACTION_MS,
  LIVE_CURABLE_OVERDUES,
  LIVE_CURE_MS,
  LIVE_DECLINES_PER_ROUND_INSTANCE,
  LIVE_FREEZE_BUDGET_MS,
  LIVE_TRADE_MS,
  emptyDeclines,
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
  /** The ROUND INSTANCE (`<round type>/<macro>/<sub>`: one Stock Round, one operating sub-round, one auction) -- the
   *  Live two-decline limit's scope. */
  readonly roundKey: string;
}

/** `optional`: an accepted action that is never a REQUIRED decision (a private company's own power, taken at any time):
 *  it neither refreshes a clock nor cures an overdue. */
export type ClockMsgClass = "deal" | "move" | "revert" | "propose" | "accept" | "reject" | "rescind" | "server-expiry" | "server-close" | "optional";

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
  /** An offer must be closed at `at` -- the controller closes it in the log as its proposer's rescission: its Live
   *  response timer ran out unanswered (`response`: a decline), or its PROPOSER's own clock ran out while it waited
   *  (`proposer-deadline`: a Live proposer whose freeze budget was used up, or a Timed Async proposer -- no decline). */
  | { readonly kind: "trade-expiry"; readonly at: number; readonly offerKey: string; readonly proposer: string; readonly recipient: string; readonly cause: "response" | "proposer-deadline" };

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

/* Owner ruling (2026-10-07): a money approval counts when it is VALID AT FINALITY -- its horizon strictly after the
   attested final second, under the consent key its seat holds then. The sealed decision then lands however late
   (escrow 2.1.0 judges every approval at `final_at`, never at the block time), so no relay margin is kept: Live, an
   approval that outlives minute 30 decides it; Async, one that outlives the completing vote completes the consensus. */

export function remainingAt(timer: ClockTimer, at: number): number {
  if (timer.since === null || at <= timer.since) return timer.remaining_ms;
  return clamp(timer.remaining_ms - (at - timer.since));
}

export function dueOf(timer: ClockTimer | null): number | null {
  return timer === null || timer.since === null ? null : timer.since + timer.remaining_ms;
}

/** A parked remainder as of `at`: a Live park is frozen; a Timed Async park keeps running from its `since`. */
export function parkedRemainingAt(p: ClockParked, at: number): number {
  const since = p.since ?? null;
  return since === null || at <= since ? p.remaining_ms : clamp(p.remaining_ms - (at - since));
}

/** A park of `seat`'s remainder behind an offer: on a Live table frozen for at most `freezeMs` of the answer's wait (the
 *  episode's freeze budget left), on a Timed Async one RUNNING. */
function parkOf(live: boolean, seat: string, offerKey: string, remainingMs: number, key: string | null, at: number, freezeMs: number | null = null): ClockParked {
  return live ? { seat, offer_key: offerKey, remaining_ms: remainingMs, key, freeze_ms: clamp(freezeMs ?? 0) } : { seat, offer_key: offerKey, remaining_ms: remainingMs, key, since: at };
}

/** LIVE: a park behind a standing offer as of `at`, measured by the answer's wait -- the answerer's RESPONSE timer for
 *  that offer (`ob`), so a voluntary pause, a system pause or an outage consumes nothing. The first `freeze_ms` of the
 *  wait is FROZEN (the episode's optional-offer freeze budget); every moment beyond it is CHARGED to the parked
 *  remainder (owner ruling, 2026-10-07). `waited`: the wait so far; `frozen` / `charged`: its two parts. */
export function liveParkAt(p: ClockParked, ob: ClockObligation | null, at: number): { readonly remaining: number; readonly freeze: number; readonly waited: number; readonly frozen: number; readonly charged: number } {
  const budget = p.freeze_ms ?? 0;
  const waited = ob !== null && ob.trade !== null && ob.trade.offer_key === p.offer_key && ob.initial_ms !== null && ob.timer !== null ? clamp(ob.initial_ms - remainingAt(ob.timer, at)) : 0;
  const frozen = Math.min(budget, waited);
  const charged = waited - frozen;
  return { remaining: clamp(p.remaining_ms - charged), freeze: budget - frozen, waited, frozen, charged };
}

/** LIVE: the moment a waiting proposer's own clock runs out -- its freeze budget used up and then its remainder -- while
 *  the answerer's response timer still runs (null: no such park, or the response timer is not running). */
function liveParkDueOf(record: Pick<GameClockRecord, "policy" | "parked" | "obligation">): { readonly park: ClockParked; readonly due: number } | null {
  const ob = record.obligation;
  if (record.policy.class !== "live" || ob === null || ob.trade === null || ob.timer === null || ob.timer.since === null || ob.initial_ms === null) return null;
  const trade = ob.trade;
  const park = record.parked.find((p) => p.since === undefined && p.freeze_ms !== undefined && p.offer_key === trade.offer_key && p.seat === trade.proposer) ?? null;
  if (park === null) return null;
  const waitedBefore = ob.initial_ms - ob.timer.remaining_ms;
  return { park, due: ob.timer.since + (park.freeze_ms as number) + park.remaining_ms - waitedBefore };
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
    /* The window restarts with each NEW obligation -- never with a resumption (a proposer resumed after its offer, an
       undo's restoration, a recovered gap) nor while a proposer stands parked behind an offer: the defaulting
       obligation's window then still holds its original grant and every park / resume since (bounded below). */
    const resumption = kind === "responsibility" && (RESUMPTION_REASONS.has(String(f.reason)) || this.d.parked.length > 0);
    if (kind === "responsibility" && !resumption && this.d.phase !== "overdue" && this.d.phase !== "ended") {
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
    /* Every overdue and cure also joins the STRIKE LEDGER (never reset by a new obligation): a sealed remedy proves the
       strike it attests from it. */
    let ledgerFrom = ev.ledger_from;
    let ledgerHead = ev.ledger_head;
    let ledger = ev.ledger;
    if (kind === "overdue" || kind === "cure") {
      ledgerHead = nextHead(ledgerHead, event);
      ledger = [...ledger, event];
      while (ledger.length > CLOCK_LEDGER_LIMIT) {
        ledgerFrom = nextHead(ledgerFrom, ledger[0]);
        ledger = ledger.slice(1);
      }
    }
    this.d.evidence = { seq: event.seq, head, window_from: from, window, truncated, ledger_from: ledgerFrom, ledger_head: ledgerHead, ledger };
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
    declines: emptyDeclines(null),
    pause: { paused_at: null, request: null, requests: 0, window: { key: null, count: 0 }, resumes: { count: 0, last_at: null } },
    system: null,
    annul: null,
    undo_floor: -1,
    snapshots: [],
    ended: null,
    remedy: null,
    acks: {},
    evidence: { seq: 0, head: genesis, window_from: genesis, window: [], truncated: false, ledger_from: ledgerGenesisHead(input.gameId), ledger_head: ledgerGenesisHead(input.gameId), ledger: [] },
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
    /* A Live ACTION obligation made here is a fresh episode's unless its caller carries the episode's budget on. */
    freeze_ms: record.policy.class === "live" && trade === null && remaining !== null ? LIVE_FREEZE_BUDGET_MS : null,
  };
}

function emitResponsibility(x: Draft, ob: ClockObligation | null, at: number, cause: { readonly actor: string | null; readonly index: number; readonly reason: string }): void {
  x.emit("responsibility", at, {
    seat: ob?.seat ?? null,
    decision: ob?.kind ?? null,
    key: ob?.key ?? null,
    timer_ms: ob?.timer?.remaining_ms ?? null,
    trade: ob?.trade !== null && ob?.trade !== undefined,
    /* Live: the episode's optional-offer freeze budget (a fresh episode's full 10:00, or what a resumption carries on). */
    freeze_ms: ob?.freeze_ms ?? null,
    actor: cause.actor,
    index: cause.index,
    reason: cause.reason,
  });
}

/* ==================================================================
    THE BATCH FOLD (after a commit, inside the committing task)
   ================================================================== */

/** Responsibility events that CONTINUE an obligation rather than begin one (the evidence window is not restarted). */
const RESUMPTION_REASONS: ReadonlySet<string> = new Set(["offer-expired", "offer-rejected", "offer-withdrawn", "offer-accepted-resumed", "offer-closed-resumed", "offer-closed-at-deadline", "undo-restored", "undo-restored-charged", "undo-unrecorded", "recovered-gap"]);

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
        current = { ...current, timer: { remaining_ms: allowance, since: at }, initial_ms: allowance, began_at: at, freeze_ms: d.policy.class === "live" && current.trade === null ? LIVE_FREEZE_BUDGET_MS : current.freeze_ms };
        d.obligation = current;
      }
    }
  }

  const before = batch.before.offer;
  const after = batch.after.offer;
  const D = batch.after.decision;
  const isLive = d.policy.class === "live";

  if (after !== null && (before === null || before.key !== after.key)) {
    /* A NEW STANDING OFFER (or a counter / continuation that replaces the standing one: whatever was parked behind the
       replaced offer stays parked behind this one -- a negotiation never loses, nor manufactures, anybody's time). */
    const proposer = after.proposer;
    const answerer = after.answerer;
    if (before !== null) d.parked = d.parked.map((p) => (p.offer_key === before.key ? { ...p, offer_key: after.key } : p));
    const answerOwed = proposer !== null && answerer !== null && proposer !== answerer && D !== null && D.seat === answerer;
    if (D !== null && current !== null && D.seat === current.seat) {
      /* The answer is owed by the seat already responsible (an offer made TO it, or an offer to oneself): nothing is
         suspended; its clock runs on; nothing parks, nothing refreshes. */
      d.obligation = { ...current, kind: D.kind, key: D.key };
    } else if (answerOwed && D !== null) {
      /* The answer is owed by another seat: the running obligation the offer suspends is PARKED at its exact remainder
         (with the decision it was for) -- on a Live table frozen only within its episode's freeze budget (owner ruling,
         2026-10-07: at most 10:00 in all per required-action episode), on a Timed Async one running. A QUALIFYING offer
         is one that suspends the PROPOSER's own required action. */
      if (current !== null && current.timer !== null && !d.parked.some((p) => p.seat === current?.seat && p.offer_key === after.key)) {
        /* LIVE: the park carries the episode's freeze budget left (owner ruling, 2026-10-07): the answer's wait is frozen
           only that long in all, never per offer. */
        d.parked = [...d.parked.filter((p) => p.seat !== current?.seat), parkOf(isLive, current.seat, after.key, remainingAt(current.timer, at), current.key, at, current.freeze_ms)];
      }
      const suspends = d.parked.some((p) => p.seat === proposer && p.offer_key === after.key);
      if (isLive && (suspends || after.slot === "train")) {
        /* LIVE: the answerer gets the distinct 10:00 RESPONSE timer -- never an action clock, an overdue or a strike (the
           owner's train rule, generalised by the owner to every inter-player offer that suspends its proposer). */
        fresh(D, after.slot === "train" ? "train-offer" : "offer", { proposer, offer_key: after.key });
        const parkedProposer = d.parked.find((p) => p.seat === proposer) ?? null;
        x.emit("trade-begin", at, { proposer, recipient: answerer, offer: after.key, index: batch.first, parked_ms: parkedProposer?.remaining_ms ?? null, freeze_ms: parkedProposer?.freeze_ms ?? null });
      } else {
        /* ASYNC (any offer), or a Live offer that suspends nothing of its proposer's: the answerer owes the next required
           decision under the ordinary responsibility model (the Async pace; the Live action clock). An Async answerer
           whose OWN deadline stands parked behind this negotiation (a counter made to the original proposer) answers
           within what that deadline has left -- never a fresh pace on top of it. */
        const ownPark = !isLive ? d.parked.find((p) => p.seat === D.seat && p.since !== undefined) : undefined;
        fresh(D, "offer", null, ownPark !== undefined && allowance !== null ? Math.min(allowance, parkedRemainingAt(ownPark, at)) : allowance);
      }
    } else {
      fresh(D, "offer");
    }
  } else if (before !== null && (after === null || after.key !== before.key)) {
    /* THE STANDING OFFER RESOLVED (accepted, rejected, expired, rescinded or otherwise closed). */
    const parkedHere = d.parked.filter((p) => p.offer_key === before.key);
    d.parked = d.parked.filter((p) => p.offer_key !== before.key);
    /* An unanswered expiry, or the server's close at a waiting proposer's deadline, is a fence: no undo may resurrect
       the closed offer. */
    if (batch.msg === "server-expiry" || batch.msg === "server-close") d.undo_floor = Math.max(d.undo_floor, batch.last);
    const selfOffer = before.proposer !== null && before.proposer === before.answerer;
    /* A qualifying offer is one that parked its proposer (it suspended the proposer's required action); a Live train
       offer is always answered on the response timer (the owner's train rule). */
    const proposerPark = parkedHere.find((p) => p.seat === before.proposer) ?? null;
    const qualifying = !selfOffer && proposerPark !== null;
    const liveQualifying = isLive && !selfOffer && (qualifying || before.slot === "train");
    /* LIVE ONLY: a rejection, or an unanswered expiry, of a qualifying offer is one DECLINE for its direction in the
       current ROUND INSTANCE (one operating sub-round -- OR 2.1 and OR 2.2 are two -- or one Stock Round; one counter per
       direction, whatever the offer's kind; once per proposal). Async keeps no decline count. A negotiation the
       answerer CONTINUES (a new offer of its own) resolves no offer here: no decline. */
    if (liveQualifying && (batch.msg === "reject" || batch.msg === "server-expiry") && before.proposer !== null && before.answerer !== null) {
      /* Once per PROPOSAL (its position in the log -- the response obligation began at it): a board key can repeat (a
         funding offer has no instance; an undo rewinds a serial), an answer undone and given again cannot. */
      const proposedAt = current !== null && current.trade !== null && current.trade.offer_key === before.key ? current.began_index : batch.first;
      bumpDeclines(x, batch.before.roundKey, declineKey(before.proposer, before.answerer), `${before.key}@${proposedAt}`.slice(-200));
    }
    /* LIVE: the proposer's wait, split into its frozen part (from the episode's freeze budget) and its charged part. */
    const waitSplit = isLive && proposerPark !== null && proposerPark.since === undefined ? liveParkAt(proposerPark, current, at) : null;
    if (liveQualifying) {
      x.emit("trade-end", at, {
        result: batch.msg === "accept" ? "accept" : batch.msg === "reject" ? "reject" : batch.msg === "server-expiry" ? "expire" : batch.msg === "server-close" ? "proposer-deadline" : batch.msg === "rescind" ? "rescind" : "other",
        proposer: before.proposer,
        recipient: before.answerer,
        offer: before.key,
        index: batch.first,
        declines: before.proposer !== null && before.answerer !== null ? (d.declines.counts[declineKey(before.proposer, before.answerer)] ?? 0) : 0,
        waited_ms: waitSplit?.waited ?? null,
        frozen_ms: waitSplit?.frozen ?? null,
        charged_ms: waitSplit?.charged ?? null,
        freeze_left_ms: waitSplit?.freeze ?? null,
      });
    }
    const answered = (batch.msg === "accept" || batch.msg === "reject") && batch.actor === before.answerer;
    /* OPTIONAL NEGOTIATION NEVER MANUFACTURES CLOCK TIME (owner rulings, 2026-10-07): whatever closed the offer -- an
       acceptance, a rejection, an unanswered expiry, a rescission, the server's close at the proposer's deadline -- a
       seat that still owes the SAME required decision it was owing when the offer suspended it resumes the SAME
       episode. LIVE: its remainder, less whatever of the answer's wait went beyond its freeze budget; the budget it
       resumes with is what is left (never replenished, whatever the resolution). TIMED ASYNC: the park kept RUNNING
       (`parkedRemainingAt`), so the seat resumes its own deadline as it stands. A seat newly responsible gets the
       ordinary fresh allowance and a fresh episode. */
    const resume = D !== null ? (parkedHere.find((p) => p.seat === D.seat && (p.key === null || p.key === D.key)) ?? null) : null;
    if (D !== null && resume !== null) {
      const live = isLive && resume.since === undefined ? liveParkAt(resume, current, at) : null;
      const resumed = live !== null ? live.remaining : parkedRemainingAt(resume, at);
      d.obligation = obligationFor(d, D, at, batch.first, resumed, null);
      d.obligation = { ...d.obligation, initial_ms: resumed, freeze_ms: live !== null ? live.freeze : null };
      const why = batch.msg === "server-expiry" ? "offer-expired" : batch.msg === "server-close" ? "offer-closed-at-deadline" : batch.msg === "reject" ? "offer-rejected" : batch.msg === "accept" ? "offer-accepted-resumed" : batch.msg === "rescind" ? "offer-withdrawn" : "offer-closed-resumed";
      emitResponsibility(x, d.obligation, at, { actor: batch.actor, index: batch.first, reason: why });
    } else if (parkedHere.length === 0 && D !== null && current !== null && D.seat === current.seat && current.trade === null && (D.key === current.key || current.key === `offer:${before.key}`)) {
      /* An offer that suspended nobody (made TO the responsible seat, or to oneself) closed -- accepted or not: that
         seat still owes the same decision and its clock runs on. */
      d.obligation = { ...current, kind: D.kind, key: D.key };
    } else {
      /* Responsibility genuinely passed (or the decision changed): the newly responsible seat starts fresh. */
      fresh(D, answered ? (batch.msg === "accept" ? "offer-accepted" : "offer-answered-handoff") : selfOffer && batch.msg === "accept" ? "accepted" : "offer-closed");
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
  /* The two-decline limit is the current ROUND INSTANCE's: the next instance (the next operating sub-round, the next
     Stock Round, any other round) starts from zero. */
  const roundKey = batch.after.roundKey;
  if (d.declines.round_key !== roundKey) {
    d.declines = emptyDeclines(roundKey);
  }
  /* Parked clocks of offers no longer standing are dropped (the offer is gone; nothing may resume from it). */
  const standing = batch.after.offer?.key ?? null;
  if (d.parked.some((p) => p.offer_key !== standing)) d.parked = d.parked.filter((p) => p.offer_key === standing);
  normalize(x, batch.at);
}

/** The Live decline counter of one direction (every qualifying inter-player offer; the owner's two-decline rule). */
export function declineKey(from: string, to: string): string {
  return `${from}>${to}`;
}

function bumpDeclines(x: Draft, roundKey: string, key: string, offerKey: string): void {
  const d = x.d;
  const same = d.declines.round_key === roundKey;
  const offers = same ? d.declines.offers : [];
  /* One offer is declined at most once (an answer undone and given again is the same decline). */
  if (offers.includes(offerKey)) return;
  const counts = same ? { ...d.declines.counts } : {};
  counts[key] = (counts[key] ?? 0) + 1;
  d.declines = { round_key: roundKey, counts, offers: [...offers, offerKey].slice(-64) };
}

function pushSnapshot(x: Draft, index: number, at: number, obligation: ClockObligation | null, parked: readonly ClockParked[], declines: GameClockRecord["declines"]): void {
  const frozen = obligation === null ? null : { ...obligation, timer: obligation.timer === null ? null : freeze(obligation.timer, at) };
  const kept = x.d.snapshots.filter((snap) => snap.index < index);
  x.d.snapshots = [...kept, { index, at, obligation: frozen, parked: [...parked], declines: { round_key: declines.round_key, counts: { ...declines.counts }, offers: [...declines.offers] } }].slice(-CLOCK_SNAPSHOT_LIMIT);
}

/** Declines never go back: the larger count per direction of two views of the same round instance. */
function mergeDeclines(a: GameClockRecord["declines"], b: GameClockRecord["declines"]): GameClockRecord["declines"] {
  if (a.round_key !== b.round_key) return a;
  const counts: Record<string, number> = { ...a.counts };
  for (const [key, count] of Object.entries(b.counts)) counts[key] = Math.max(counts[key] ?? 0, count);
  return { round_key: a.round_key, counts, offers: [...new Set([...a.offers, ...b.offers])].slice(-64) };
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
    /* A seat undoing its OWN action is charged everything since it took it, whoever held the clock meanwhile: an
       act-handoff-undo-redo cycle can never refresh the next seat's clock for free (an endless stall). */
    const selfUndo = batch.actor === prior.seat;
    const charge =
      sameSeatThroughout || parkedSince || selfUndo
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
      /* The charge is not part of this run's own use: a later measure of the run (a rescission's `ran`) excludes it, so
         nothing is charged twice. */
      initial_ms: prior.initial_ms === null ? null : clamp(prior.initial_ms - charge),
    };
    /* A park restored for the seat whose CURRENT run began at the undone batch (it resumed there -- the answer to its
       offer is what is undone) is never given back more than that run has left: an undo never gives time. A running
       (Timed Async) park is restored as it stands now. */
    d.parked = snap.parked.map((p) => {
      /* A running (Timed Async) park already counted every moment since it was parked. A frozen (Live) park is charged
         exactly what its seat's own run since the undone batch used -- never the offer's standing time again. */
      if (p.since !== undefined) return parkOf(false, p.seat, p.offer_key, parkedRemainingAt(p, at), p.key, at);
      const ran = current !== null && current.seat === p.seat && current.began_index === target && current.timer !== null && current.initial_ms !== null ? clamp(current.initial_ms - remainingAt(current.timer, at)) : 0;
      return ran === 0 ? p : parkOf(true, p.seat, p.offer_key, clamp(p.remaining_ms - ran), p.key, at, p.freeze_ms ?? 0);
    });
    how = charge > 0 ? "undo-restored-charged" : "undo-restored";
  } else if (D === null) {
    restored = null;
    how = "undo-nobody-owes";
  } else {
    /* No snapshot (older than the ring, or a recovered gap): never a fresh allowance -- the restored seat continues
       with the time the current clock has left (or, being the same seat, simply continues). */
    const left = current?.timer !== null && current?.timer !== undefined ? remainingAt(current.timer, at) : allowanceOf(d);
    restored = obligationFor(d, D, at, batch.first, left, null);
    /* Never a fresh freeze budget either: the same seat's episode carries on with what it had; another seat gets none. */
    if (restored.freeze_ms !== null) restored = { ...restored, freeze_ms: current !== null && current.seat === D.seat && current.trade === null ? (current.freeze_ms ?? 0) : 0 };
    how = "undo-unrecorded";
  }
  if (snap !== null && snap.declines.round_key === batch.after.roundKey) d.declines = mergeDeclines(snap.declines, d.declines);
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
  d.declines = emptyDeclines(batch.after.roundKey);
  emitResponsibility(x, d.obligation, at, { actor: batch.actor, index: batch.first, reason: "deal" });
  normalize(x, at);
}

function endGame(x: Draft, kind: ClockEndKind, at: number, seat: string | null): void {
  const d = x.d;
  if (d.phase === "ended") return;
  normalize(x, at);
  d.phase = "ended";
  d.ended = { kind, at, seat };
  /* Nothing is timed once the game has ended: no pause (voluntary or SYSTEM) outlives it, and no later break pauses it
     (`continuityBreak`): a sealed remedy is carried on without any player vote (the owner's ruling). */
  d.pause = { ...d.pause, request: null, paused_at: null };
  d.system = null;
  d.annul = null;
  /* No undo reaches an ended game: its undo snapshots are dropped (the record stays small). */
  d.snapshots = [];
  if (d.obligation !== null && d.obligation.timer !== null) d.obligation = { ...d.obligation, timer: freeze(d.obligation.timer, at) };
  if (d.overdue !== null && d.overdue.cure !== null) d.overdue = { ...d.overdue, cure: freeze(d.overdue.cure, at) };
  x.emit("ended", at, { kind, seat });
}

/* ==================================================================
    TIME: OVERDUE, FINALITY, THE TRADE RESPONSE (`advance`)
   ================================================================== */

/** Live (money): the controller's chain read of the standing YES approvals AT a foreclosure's final second -- the seats
 *  whose approval does not verify under the consent key their seat held then (`RemedyPort.staleApprovals` with
 *  `atSecs`). Bound to one overdue, one proposal and one final second; anything else is ignored. */
export interface FinalityKeyCheck {
  readonly epoch: number;
  readonly proposal: number;
  readonly final_secs: number;
  readonly stale: readonly string[];
}

/** Live (money): the finality a key check must be made for before `advance` reaches it at `now` -- a COMPLETE N-1
 *  foreclosure whose minute 30 falls due by `now` -- or null (none due, or nothing to check). */
export function finalityKeyCheckDue(record: GameClockRecord, now: number): { readonly epoch: number; readonly proposal: number; readonly final_secs: number; readonly votes: readonly ClockVote[] } | null {
  const od = record.overdue;
  if (!record.money || record.policy.class !== "live" || record.phase !== "overdue" || od === null || od.cure === null) return null;
  if (record.system !== null || record.pause.paused_at !== null) return null;
  const proposal = od.proposal;
  if (proposal === null || proposal.kind !== "foreclose" || proposal.complete_at === null) return null;
  const due = dueOf(od.cure);
  if (due === null || due > now) return null;
  return { epoch: od.epoch, proposal: proposal.id, final_secs: finalSecsOf(od, due), votes: proposal.votes.filter((v) => v.yes && v.approval !== null) };
}

/** The controller tried to read the approvers' keys at a Live money finality's final second and could not (no quorum,
 *  or no block past that second in time): nothing may be decided on approvals whose validity at finality is unknown. */
export const FINALITY_KEYS_UNREAD = "unread" as const;

/** Processes every transition due by `now`, in time order, each AT ITS OWN MOMENT (never at `now`). Stops at a train
 *  offer's expiry: that needs the log (the controller closes the offer, then folds it and advances again). `keys`: the
 *  controller's key check for a Live money finality due by `now` (`finalityKeyCheckDue`); null when none was made;
 *  `FINALITY_KEYS_UNREAD` when the chain could not be read: that finality is then NOT processed (`finalityPending`) --
 *  it stays due at its own moment, decided once the keys are read (fail closed: never a seal whose approvals' keys at
 *  finality are unknown, never a cure after its moment -- the controller refuses every move and vote meanwhile). */
export function advance(record: GameClockRecord, now: number, position: LogPosition, keys: FinalityKeyCheck | null | typeof FINALITY_KEYS_UNREAD = null): ClockStep & { readonly tradeExpiry: Extract<ClockEffect, { kind: "trade-expiry" }> | null; readonly finalityPending: boolean } {
  const x = new Draft(record, now);
  const d = x.d;
  for (let guard = 0; guard < 8; guard += 1) {
    if (d.phase !== "active" && d.phase !== "overdue") break;
    if (d.system !== null || d.pause.paused_at !== null) break;
    const ob = d.obligation;
    /* TIMED ASYNC: an offer's proposer whose RUNNING park reaches zero while the offer is answered has reached its own
       deadline -- the offer is closed by the server at that moment (the proposer's rescission, as a Live response
       timer's expiry is), and the proposer, owing its decision with nothing left, is overdue at it. The answer window
       never outlives the proposer's deadline (owner, 2026-10-07: negotiation never extends an Async deadline). */
    const drained = d.phase === "active" ? drainedParkOf(d) : null;
    if (drained !== null && drained.due <= now && (ob === null || ob.timer === null || dueOf(ob.timer) === null || drained.due <= (dueOf(ob.timer) as number))) {
      return { ...x.done(), tradeExpiry: { kind: "trade-expiry", at: drained.due, offerKey: drained.park.offer_key, proposer: drained.park.seat, recipient: ob?.seat ?? drained.park.seat, cause: "proposer-deadline" }, finalityPending: false };
    }
    /* LIVE: a proposer whose freeze budget is used up keeps running while its offer waits; if its OWN clock runs out
       strictly before the answerer's response time does, the server closes the offer at that moment (no decline -- the
       answerer did nothing wrong, and is never struck) and the proposer, owing its decision with nothing left, is
       OVERDUE at it under the ordinary Live rules. */
    const liveDrain = d.phase === "active" ? liveParkDueOf(d) : null;
    if (liveDrain !== null && ob !== null && ob.trade !== null && liveDrain.due <= now && liveDrain.due < (dueOf(ob.timer) ?? Number.MAX_SAFE_INTEGER)) {
      return { ...x.done(), tradeExpiry: { kind: "trade-expiry", at: liveDrain.due, offerKey: ob.trade.offer_key, proposer: liveDrain.park.seat, recipient: ob.seat, cause: "proposer-deadline" }, finalityPending: false };
    }
    if (d.phase === "active" && ob !== null && ob.timer !== null) {
      const due = dueOf(ob.timer);
      if (due !== null && due <= now) {
        if (ob.trade !== null) {
          const step = x.done();
          return { ...step, tradeExpiry: { kind: "trade-expiry", at: due, offerKey: ob.trade.offer_key, proposer: ob.trade.proposer, recipient: ob.seat, cause: "response" }, finalityPending: false };
        }
        becomeOverdue(x, due, position);
        continue;
      }
    }
    const od = d.overdue;
    if (d.phase === "overdue" && od !== null && od.cure !== null) {
      const due = dueOf(od.cure);
      if (due !== null && due <= now) {
        const check = finalityKeyCheckDue(d, due);
        /* Unread -- or a check made for another overdue, proposal or final second -- decides nothing. */
        const unknown = check !== null && (keys === FINALITY_KEYS_UNREAD || (keys !== null && (keys.epoch !== check.epoch || keys.proposal !== check.proposal || keys.final_secs !== check.final_secs)));
        if (unknown) return { ...x.done(), tradeExpiry: null, finalityPending: true };
        finality(x, due, keys === FINALITY_KEYS_UNREAD ? null : keys);
        continue;
      }
    }
    break;
  }
  return { ...x.done(), tradeExpiry: null, finalityPending: false };
}

/** When the next transition falls due (ms), or `null` (nothing is counting down). */
export function nextDue(record: GameClockRecord): number | null {
  if (record.phase !== "active" && record.phase !== "overdue") return null;
  if (record.system !== null || record.pause.paused_at !== null) return null;
  if (record.phase === "active") {
    const dues = [dueOf(record.obligation?.timer ?? null), drainedParkOf(record)?.due ?? null, liveParkDueOf(record)?.due ?? null].filter((due): due is number => due !== null);
    return dues.length === 0 ? null : Math.min(...dues);
  }
  return dueOf(record.overdue?.cure ?? null);
}

/** Timed Async: the earliest RUNNING park (of a seat other than the one answering) and the moment it reaches zero. */
function drainedParkOf(record: Pick<GameClockRecord, "parked" | "obligation">): { readonly park: ClockParked; readonly due: number } | null {
  let best: { readonly park: ClockParked; readonly due: number } | null = null;
  for (const park of record.parked) {
    if (park.since === undefined || park.seat === record.obligation?.seat) continue;
    const due = park.since + park.remaining_ms;
    if (best === null || due < best.due) best = { park, due };
  }
  return best;
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

function finality(x: Draft, at: number, keys: FinalityKeyCheck | null): void {
  const d = x.d;
  const od = d.overdue as ClockOverdue;
  const proposal = od.proposal;
  /* The attestation's own final moment (whole seconds, never earlier than the overdue plus the 10-minute window): an
     approval that does not outlive it cannot decide minute 30. */
  const finalSecs = finalSecsOf(od, at);
  const complete = proposal !== null && proposal.kind === "foreclose" && proposal.complete_at !== null;
  /* Money: a YES whose seat's consent key was replaced at or before this final second (the controller's chain read AT
     finality, bound to this overdue and proposal) is void before the seal -- the N-1 consensus is then incomplete. */
  const moved =
    d.money && complete && keys !== null && keys.epoch === od.epoch && keys.proposal === (proposal as ClockProposal).id && keys.final_secs === finalSecs
      ? (proposal as ClockProposal).votes.filter((v) => v.yes && keys.stale.includes(v.seat)).map((v) => v.seat)
      : [];
  for (const seat of moved) x.emit("vote-stale", at, { epoch: od.epoch, id: (proposal as ClockProposal).id, seat, reason: "key-moved" });
  const valid = complete && (!d.money || (approvalsOutlive((proposal as ClockProposal).votes, finalSecs) && moved.length === 0));
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

/** Live (money): every YES approval of the complete foreclosure outlives `finalSecs` (valid at finality). */
function approvalsOutlive(votes: readonly ClockVote[], finalSecs: number): boolean {
  return votes.every((v) => !v.yes || (v.approval !== null && v.approval.approve_until > finalSecs));
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
    /* The strike ledger as of the seal: its events travel with the document, its head is signed through this event. */
    ledger_head: d.evidence.ledger_head,
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
    evidence: { format: CLOCK_EVIDENCE_FORMAT, game_id: d.game_id, prev_head: ev.window_from, events: [...ev.window], truncated: ev.truncated, ledger: { from: ev.ledger_from, events: [...ev.ledger] } },
    evidence_hash: ev.head,
    sealed_at: finalMs,
    status: "sealed",
    detail: null,
    attestations: 0,
    replaces,
    stale: [],
  };
  /* The sealed window now lives in the remedy document: the record's own restarts at the seal's head (the chain is
     unchanged; the record is not carried twice toward a store's item limit). */
  d.evidence = { ...d.evidence, window_from: d.evidence.head, window: [], truncated: false };
  x.effects.push({ kind: "remedy" });
}

/** The pipeline's progress on the sealed remedy (`submitted` once attested and handed to FP4, `confirmed` on chain,
 *  `superseded` when the game ended another way, `refused` while it cannot be attested -- fail closed). */
export function remedyProgress(record: GameClockRecord, status: RemedyStatus, detail: string | null, now: number, attested = false): ClockStep {
  const r = record.remedy;
  if (r === null) return { record, events: [], effects: [] };
  if (r.status === status && r.detail === detail && !attested) return { record, events: [], effects: [] };
  const x = new Draft(record, now);
  /* Seats named unlandable are cleared once the decision is carried on again (submitted, confirmed, superseded). */
  const stale = status === "refused" || status === "sealed" ? r.stale : [];
  x.d.remedy = { ...r, status, detail: detail === null ? null : detail.slice(0, 500), attestations: r.attestations + (attested ? 1 : 0), stale };
  /* The evidence says WHAT happened (a status), never the free text of why (signer, chain or host errors stay in the
     record and the ops lines). */
  if (r.status !== status) x.emit("remedy-status", now, { remedy: r.kind, status });
  else x.touch();
  return x.done();
}

/** A sealed N-1 remedy (Live foreclosure 2; Async annulment 4 or foreclosure 5) whose seat approvals were NOT valid at
 *  its own final second (a horizon at or before it, or a seat's consent key replaced at or before it -- escrow 2.1.0
 *  judges each approval at `final_at`, owner ruling 2026-10-07; a race the pre-seal checks could not see). The owner's
 *  rule (policy correction, 2026-10-06): a sealed terminal remedy is never changed, recalculated, converted to another
 *  outcome or put to a new vote. Such approvals can never land, so the SAME decision stays sealed and is HELD (`refused`, its detail naming the owner decision it needs); `stale` names the seats
 *  (informational). Nothing is attested on it; nobody is asked to approve again. */
export function remedyBlocked(record: GameClockRecord, seats: readonly string[], detail: string, now: number): ClockStep {
  const r = record.remedy;
  if (r === null || (r.kind !== 2 && r.kind !== 4 && r.kind !== 5) || r.status === "confirmed" || r.status === "superseded") return { record, events: [], effects: [] };
  const stale = [...new Set(seats.filter((seat) => r.approvals.some((a) => a.seat === seat)))].sort();
  const text = detail.slice(0, 500);
  if (stale.length === r.stale.length && stale.every((seat, i) => r.stale[i] === seat) && r.status === "refused" && r.detail === text) return { record, events: [], effects: [] };
  const x = new Draft(record, now);
  x.d.remedy = { ...r, status: "refused", detail: text, stale };
  x.emit("remedy-status", now, { remedy: r.kind, status: "approvals-unlandable", seats: stale });
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
  options: { readonly kind?: ClockProposalKind | null; readonly stale?: readonly string[]; readonly renew?: boolean } = {},
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
  /* A standing YES is renewed only to reach meaningfully further (a minute or more): a re-vote never floods the record. */
  if (prior !== null && prior.yes && yes && prior.approval !== null && approval !== null && approval.approve_until < prior.approval.approve_until + 60 && options.renew !== true) return { record, events: [], effects: [] };
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
 *  approval is valid NOW: an Async one must outlive the completing moment (it is then final -- owner ruling,
 *  2026-10-07: valid at finality decides), and none whose seat's consent key moved since it signed (`stale`, found by
 *  the caller's chain read) -- those YES votes are set aside (evidence: `vote-stale`) and the seat is asked again;
 *  nothing is sealed on an approval that was not valid when the decision became final. */
function completeIfUnanimous(x: Draft, now: number, stale: readonly string[] = []): void {
  const d = x.d;
  let od = d.overdue as ClockOverdue;
  let proposal = od.proposal as ClockProposal;
  if (proposal.complete_at !== null) return;
  if (d.money) {
    /* The completing moment's attested second (`remedyTimes`: rounded up): an approval must end strictly after it. */
    const horizon = secsUpOf(now);
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
    let resumes = record.pause.resumes;
    if (op.kind === "pause") {
      const key = record.obligation?.key ?? null;
      const used = window.key === key ? window.count : 0;
      if (used >= CLOCK_PAUSE_REQUESTS_PER_OBLIGATION) return { code: "rate-limited", reason: "Too many pause requests for this action. Ask again after the next move." };
      window = { key, count: used + 1 };
    } else {
      if (resumes.count >= CLOCK_RESUME_BURST && resumes.last_at !== null && now - resumes.last_at < CLOCK_RESUME_SPACING_MS) return { code: "rate-limited", reason: "Ask to resume again in a minute." };
      resumes = { count: resumes.count + 1, last_at: now };
    }
    const id = record.pause.requests + 1;
    d.pause = { ...d.pause, requests: id, window, resumes, request: { id, kind: op.kind, by, at: now, yes: [by] } };
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
    d.pause = { ...d.pause, paused_at: now, request: null, resumes: { count: 0, last_at: null } };
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
 *  continuity between them is NOT proven. While the game still has PLAYABLE state -- Live, not ended (an overdue whose
 *  remedy is not yet sealed included) -- it enters SYSTEM PAUSE (no vote to enter, unanimous to leave), every timer
 *  frozen as of `preservedAt` -- the last instant the earlier authority proved it was in control -- and every
 *  not-yet-final vote staled. Timed Async: the outage is credited (the timers resume, as of `preservedAt`, from now).
 *  No-deadline: nothing is timed. A game already ENDED has nothing to resume (the owner's ruling, policy correction
 *  2026-10-06): no system pause and no player vote -- a sealed terminal remedy is carried on technically (revalidated
 *  and submitted, or attested again, unchanged) by the controller's remedy drive. Decisions are never made ACROSS a
 *  break: the timers of a running game are frozen as of the last proven instant, and a stall inside one process is a
 *  break too (`clockController.ts`, `CLOCK_CONTINUITY_GAP_*`). */
export function continuityBreak(record: GameClockRecord, input: { readonly now: number; readonly preservedAt: number; readonly reason: string; readonly authority: string; readonly resumeFrom?: number }): ClockStep {
  const x = new Draft(record, input.now);
  const d = x.d;
  const preserved = Math.min(Math.max(input.preservedAt, 0), input.now);
  if (d.phase === "setup") {
    x.touch();
    return x.done();
  }
  const timed = d.policy.class === "live" && d.phase !== "ended";
  /* LIVE: a minute 30 that fell due WITHIN the proven continuity (at or before `preserved`) -- not yet processed (its
     approvers' keys unread, or its timer lost) -- is not crossed by this break: it is decided at its own moment, by the
     next catch-up, on the votes standing then; no veto, no pause. */
  const cure = d.phase === "overdue" && d.overdue !== null ? d.overdue.cure : null;
  if (timed && d.system === null && d.pause.paused_at === null && cure !== null && cure.since !== null && (dueOf(cure) as number) <= preserved) {
    x.touch();
    return x.done();
  }
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
    /* The outage is never charged: every timer as of `preserved`, running on from when this authority began serving
       (`resumeFrom`: a table nobody opened after the restart was still served -- that time is real), or from now. */
    const ob = d.obligation;
    const from = Math.min(input.now, Math.max(preserved, input.resumeFrom ?? input.now));
    if (ob !== null && ob.timer !== null && ob.timer.since !== null) d.obligation = { ...ob, timer: { remaining_ms: remainingAt(ob.timer, preserved), since: from } };
    /* A parked (running) Async remainder is credited the same outage. */
    if (d.parked.some((p) => p.since !== undefined)) d.parked = d.parked.map((p) => (p.since === undefined ? p : { ...p, remaining_ms: parkedRemainingAt(p, preserved), since: from }));
    /* A credited outage is a fence: no undo reaches back across it (it would charge the outage). */
    d.undo_floor = Math.max(d.undo_floor, d.watermark);
    x.emit("outage-credited", input.now, { preserved_at: preserved, credited_ms: from - preserved });
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
    /* (A funding offer is made TO the seat that owes the decision: it suspends nobody -- as `foldBatch` folds it.) */
    const standing = offer !== null && offer.proposer !== null && offer.answerer === D.seat && offer.proposer !== D.seat && offer.slot !== "funding" ? offer : null;
    let keptPark: ClockParked | null = null;
    if (standing !== null && standing.proposer !== null) {
      /* The proposer's own park: of THIS offer, or -- the gap closed its earlier offer and it proposed again -- of an
         earlier one (never a fresh allowance from a gap). */
      const kept = keptParked.find((p) => p.offer_key === standing.key && p.seat === standing.proposer) ?? (!input.actors.includes(standing.proposer) ? (keptParked.find((p) => p.seat === standing.proposer) ?? null) : null);
      keptPark = kept;
      const parkedMs = kept !== null ? parkedRemainingAt(kept, at) : prior !== null && prior.seat === standing.proposer && prior.timer !== null ? remainingAt(prior.timer, at) : (allowance ?? 0);
      /* (Live: the park's freeze budget is the kept park's, else the proposer's own episode's, else a fresh episode's.) */
      const freeze = kept !== null ? (kept.freeze_ms ?? 0) : prior !== null && prior.seat === standing.proposer && prior.trade === null ? (prior.freeze_ms ?? 0) : LIVE_FREEZE_BUDGET_MS;
      if (allowance !== null) d.parked = [parkOf(d.policy.class === "live", standing.proposer, standing.key, parkedMs, kept !== null ? kept.key : prior !== null && prior.seat === standing.proposer ? prior.key : null, at, freeze)];
    }
    /* LIVE: the response timer for a train offer and for any offer that suspended its proposer (the proposer held the
       running obligation, or this record already parked it behind this offer) -- as `foldBatch` decides it. */
    const suspended =
      standing !== null &&
      ((prior !== null && prior.seat === standing.proposer && prior.timer !== null && prior.trade === null) ||
        keptPark !== null ||
        /* The proposer acted in the gap and proposed after (only the responsible seat proposes): it suspended itself. */
        (allowance !== null && standing.proposer !== null && input.actors.includes(standing.proposer)) ||
        (prior !== null && prior.trade !== null && prior.trade.offer_key === standing.key));
    const trade = d.policy.class === "live" && standing !== null && standing.proposer !== null && (standing.slot === "train" || suspended) ? { proposer: standing.proposer, offer_key: standing.key } : null;
    const continues = prior !== null && prior.seat === D.seat && !input.actors.includes(D.seat) && cured !== D.seat && (prior.trade?.offer_key ?? null) === (trade?.offer_key ?? null);
    if (continues && prior !== null) {
      d.obligation = { ...prior, kind: D.kind, key: D.key, timer: prior.timer === null ? null : { remaining_ms: remainingAt(prior.timer, at), since: at } };
    } else {
      /* A seat resumes a closed offer's park only while it owes the SAME decision and took no required action in the gap
         (as `foldBatch` resumes it); otherwise responsibility genuinely passed: fresh. */
      const resumed = trade === null && cured !== D.seat && !input.actors.includes(D.seat) ? (keptParked.find((p) => p.seat === D.seat && p.offer_key !== standing?.key && (p.key === null || p.key === D.key)) ?? null) : null;
      d.obligation = obligationFor(d, D, at, input.lastIndex, trade !== null ? LIVE_TRADE_MS : resumed !== null && allowance !== null ? parkedRemainingAt(resumed, at) : allowance, trade);
      /* A resumed Live park carries its episode's freeze budget on (never a fresh one from a gap). */
      if (resumed !== null && d.obligation.freeze_ms !== null) d.obligation = { ...d.obligation, freeze_ms: resumed.freeze_ms ?? 0 };
    }
  }
  d.declines = d.declines.round_key === input.facts.roundKey ? d.declines : emptyDeclines(input.facts.roundKey);
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
  if (record.money) return { code: "wrong-state", reason: "A table with stakes is annulled through its escrow: use “Agree to cancel this game” in the money panel." };
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
  if (d.annul === null) {
    /* Starting an annulment is bounded per obligation like a pause request (a YES / NO toggle never floods the record). */
    const key = d.obligation?.key ?? null;
    const used = d.pause.window.key === key ? d.pause.window.count : 0;
    if (used >= CLOCK_PAUSE_REQUESTS_PER_OBLIGATION) return { code: "rate-limited", reason: "Too many annulment requests for this action. Ask again after the next move." };
    d.pause = { ...d.pause, window: { key, count: used + 1 } };
  }
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
    if (count >= LIVE_DECLINES_PER_ROUND_INSTANCE) return { code: CLOCK_REFUSAL.declines, reason: declinesReachedSentence(input.nameOf(input.trainRecipient)) };
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
  /* The waiting proposer's park as of now: its clock (frozen while its episode's freeze budget lasts, then running) and
     the budget left -- both counted on by the answerer's response timer. */
  const proposerPark = ob?.trade ? (record.parked.find((p) => p.seat === ob.trade?.proposer && p.offer_key === ob.trade?.offer_key) ?? null) : null;
  const parkNow = proposerPark === null ? null : proposerPark.since !== undefined ? { remaining: parkedRemainingAt(proposerPark, now), freeze: 0 } : liveParkAt(proposerPark, ob ?? null, now);
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
    trade:
      ob?.trade && record.phase !== "ended"
        ? {
            proposer: ob.trade.proposer,
            recipient: ob.seat,
            respond: timerView(ob.timer) ?? { remainingMs: 0, running: false },
            proposerRemainingMs: parkNow?.remaining ?? 0,
            proposerFreezeMs: parkNow?.freeze ?? 0,
            kind: offerKindOf(ob.trade.offer_key),
          }
        : null,
    /* Live: the responsible seat's optional-offer freeze budget left in this required-action episode. */
    freezeBudgetMs: ob !== null && ob.trade === null && record.phase !== "ended" ? ob.freeze_ms : null,
    running: record.phase === "ended" ? [] : record.parked.filter((p) => p.since !== undefined).map((p) => ({ seat: p.seat, remainingMs: parkedRemainingAt(p, now) })),
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
    /* (A key with a kind prefix is a pre-correction development record's: not a direction, not shown.) */
    declines: Object.entries(record.declines.counts)
      .filter(([key]) => !key.includes(":"))
      .map(([key, count]) => {
      const [from, to] = key.split(">");
      return { from, to, count };
    }),
    annul: record.annul === null ? null : { yes: [...record.annul.yes], needed: [...record.seats] },
    noDeadlineAcks: Object.keys(record.acks).sort(),
    seats: [...record.seats],
  };
}

/** The kind of a standing offer from its key (`train:`, `private:`, `trade:`, `funding:`). */
function offerKindOf(key: string): "train" | "private" | "trade" | "funding" {
  const prefix = key.slice(0, key.indexOf(":"));
  return prefix === "private" || prefix === "trade" || prefix === "funding" ? prefix : "train";
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
