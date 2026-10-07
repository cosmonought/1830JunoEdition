// server/src/rooms/clock/clockRecord.ts
//
// ==================================================================
//  PHASE 3 FINAL CLOCKS: THE DURABLE TABLE-CLOCK RECORD (`gs-game-clock` v2) -- SHAPE, LIMITS, PARSING
// ==================================================================
//
// One record per table, CONTROL-PLANE ONLY: `games/clocks/<game_id>.json` (file stores), `GAME#<g>/CLOCK` (DynamoDB,
// every write fenced by the game's HEAD and a CAS on `revision`), memory (tests). It is never in the gameplay log (a
// timer is not a move of 1830 and must never enter the settlement commitment) and never in the GameRecord (exact-keyed
// for LIVE-4 continuation). It IS decided inside the game's own serialization (the actor's task queue), so every clock
// fact is totally ordered with every move: a cure and a finality, a train answer and its expiry, a pause and a move
// can never race.
//
// Version 2 supersedes the provisional v1 of the unmerged lane-A reference (count-up, per turn, host-only pause, no
// consequences): a v1 document is classified `older` and never read or overwritten (the table's clock is shown
// unavailable; nothing of v1 ever reached a deployed table).
//
// INTEGER MILLISECONDS ONLY. Every time is a safe, non-negative integer; nothing is a float.

import type { RequiredDecisionKind } from "../../../../frontend/src/gameEngine/clockResponsibility";
import type { ClockDeadlineClass, ClockEndKind, ClockProposalKind } from "../../../../frontend/src/utils/clockProtocol";
import { GAME_ID_PATTERN } from "../gameRecord";
import type { ClockEvidenceEvent, RemedyEvidenceDocument } from "./clockEvidence";

export const CLOCK_FORMAT = "gs-game-clock";
export const CLOCK_VERSION = 2;

/** Escrow 2.1.0's policy constants, in ms (`contracts/escrow/src/state.rs`, `junoRemedyV1.ts`). */
export const LIVE_ACTION_MS = 20 * 60_000;
export const LIVE_CURE_MS = 10 * 60_000;
export const LIVE_TRADE_MS = 10 * 60_000;
export const ASYNC_PACES_SECS: readonly number[] = Object.freeze([43_200, 86_400, 172_800, 259_200, 604_800]);
/** Live: the current Operating Round's train-offer declines per direction ("from>to"), and the offers already counted
 *  (an offer is declined at most ONCE: an answer undone and given again never counts twice). */
export interface ClockDeclines {
  readonly or_key: string | null;
  readonly counts: Readonly<Record<string, number>>;
  readonly offers: readonly string[];
}

export const emptyDeclines = (orKey: string | null): ClockDeclines => ({ or_key: orKey, counts: {}, offers: [] });

/** Live: the declines (rejections or unanswered expiries) one direction may collect in one Operating Round. */
export const LIVE_DECLINES_PER_OR = 2;
/** Live: the ordinary overdues a seat may cure; the next forecloses at once. */
export const LIVE_CURABLE_OVERDUES = 2;

/** Bounds that keep the record small (a DynamoDB item is 400 KB). */
export const CLOCK_SNAPSHOT_LIMIT = 48;
/** The strike ledger keeps the newest this many overdue / cure events (a Live game has at most 5 per seat). */
export const CLOCK_LEDGER_LIMIT = 64;
/** Resume requests in one pause before they are limited to one a minute. */
export const CLOCK_RESUME_BURST = 16;
export const CLOCK_RESUME_SPACING_MS = 60_000;
export const CLOCK_EVIDENCE_WINDOW = 512;
export const CLOCK_PROPOSALS_PER_OVERDUE = 16;
export const CLOCK_PAUSE_REQUESTS_PER_OBLIGATION = 16;

/** One countdown: `remaining_ms` as of `since` when running (`since !== null`), or exactly `remaining_ms` when frozen. */
export interface ClockTimer {
  readonly remaining_ms: number;
  readonly since: number | null;
}

/** The decision the clock times: one human, one required decision. */
export interface ClockObligation {
  readonly seat: string;
  readonly kind: RequiredDecisionKind;
  readonly key: string;
  readonly began_at: number;
  /** The first log index of the batch that began it (the deal's included); -1 when not from a batch. */
  readonly began_index: number;
  /** What it began with (an undo charges what was used since); `null` for No-deadline. */
  readonly initial_ms: number | null;
  /** `null` for No-deadline (no clock). */
  readonly timer: ClockTimer | null;
  /** Live: a train offer's 10-minute RESPONSE timer (never an action clock, never an overdue timer). */
  readonly trade: { readonly proposer: string; readonly offer_key: string } | null;
}

/** A proposer's clock set aside while its counterparty answers an offer: resumed exactly (rescind, unanswered expiry),
 *  or discarded when the counterparty answers (the proposer's next decision then begins fresh). */
export interface ClockParked {
  readonly seat: string;
  readonly offer_key: string;
  readonly remaining_ms: number;
}

export interface ClockVote {
  readonly seat: string;
  readonly yes: boolean;
  readonly at: number;
  /** Money tables, a YES: the seat's REMEDY-APPROVE (its own consent key over its own horizon, seconds). */
  readonly approval: { readonly approve_until: number; readonly signature: string } | null;
}

export interface ClockProposal {
  readonly id: number;
  readonly kind: ClockProposalKind;
  readonly by: string;
  readonly at: number;
  readonly votes: readonly ClockVote[];
  /** When every non-defaulting seat's YES was in (Live: the pending minute-30 outcome; Async: final). */
  readonly complete_at: number | null;
}

export interface ClockOverdue {
  /** Monotonic per game (1, 2, ...): the attestation's `overdue_epoch`. */
  readonly epoch: number;
  readonly seat: string;
  /** Live: the seat's ordinary overdue count (1, 2; a 3 ends the game at once); Async: 0. */
  readonly strike: number;
  /** The exact moment the allowance ran out (ms). */
  readonly at: number;
  /** The authoritative log position the game stalled at (committed entries) and its log hash. */
  readonly log_len: number;
  readonly log_hash: string;
  readonly decision_kind: RequiredDecisionKind;
  /** Live strikes 1-2: the 10-minute cure / resolution window to the minute-30 finality. `null` for Async. */
  readonly cure: ClockTimer | null;
  readonly proposal: ClockProposal | null;
  /** Proposals made in this instance (bounded). */
  readonly proposals: number;
}

export interface ClockPause {
  /** When the unanimous pause began (`null`: not paused). */
  readonly paused_at: number | null;
  readonly request: { readonly id: number; readonly kind: "pause" | "resume"; readonly by: string; readonly at: number; readonly yes: readonly string[] } | null;
  /** The request id counter (never capped: it only names requests). */
  readonly requests: number;
  /** PAUSE requests (and a free table's annulment starts) made during the current obligation (`key`): bounded per
   *  obligation, reset when it changes. */
  readonly window: { readonly key: string | null; readonly count: number };
  /** RESUME requests in the current pause: never refused outright (a paused game can always be asked to resume), but
   *  past a burst only one a minute. */
  readonly resumes: { readonly count: number; readonly last_at: number | null };
}

export interface ClockSystemPause {
  /** When the server recovered and paused (ms). */
  readonly since: number;
  /** The last instant this table's authority was PROVEN continuous; every timer is as of then. */
  readonly preserved_at: number;
  readonly reason: string;
  readonly yes: readonly string[];
}

export interface ClockEnded {
  readonly kind: ClockEndKind;
  readonly at: number;
  readonly seat: string | null;
}

export type RemedyKind = 1 | 2 | 3 | 4 | 5;
export type RemedyStatus = "sealed" | "submitted" | "confirmed" | "superseded" | "refused";

/** A money table's sealed remedy DECISION (the attestation's time-independent part, plus its evidence). */
export interface ClockRemedy {
  readonly kind: RemedyKind;
  /** The defaulting player (its chain seat is read from the frozen roster when attested). */
  readonly seat: string;
  readonly strike: number;
  readonly epoch: number;
  readonly log_len: number;
  readonly log_hash: string;
  readonly allowance_secs: number;
  readonly overdue_ms: number;
  readonly final_ms: number;
  /** The N-1 approvals (player ids), for remedies 2, 4 and 5. */
  readonly approvals: readonly { readonly seat: string; readonly approve_until: number; readonly signature: string }[];
  readonly evidence: RemedyEvidenceDocument;
  readonly evidence_hash: string;
  readonly sealed_at: number;
  readonly status: RemedyStatus;
  readonly detail: string | null;
  /** How many times it was attested (a lapsed attestation of the same decision is attested again). */
  readonly attestations: number;
  /** Always `null` since the owner-policy correction (2026-10-06): a sealed decision is never replaced by another. Kept
   *  in the sealed shape (and its seal event) for format stability. */
  readonly replaces: RemedyKind | null;
  /** N-1 remedies (2, 4, 5): the approving seats whose REMEDY-APPROVE can no longer land (a horizon passed, or the
   *  seat's consent key moved since it signed). Informational: the SAME decision stays sealed and held (`refused`, owner
   *  decision required) -- nobody is asked to approve again, nothing is converted (`remedyBlocked`). */
  readonly stale: readonly string[];
}

export interface ClockSnapshot {
  /** The first index of the batch this is the state before. */
  readonly index: number;
  readonly at: number;
  /** As of `at`, frozen (re-anchored when restored). */
  readonly obligation: ClockObligation | null;
  readonly parked: readonly ClockParked[];
  /** The decline counts as of `at` (an undo across an Operating Round boundary restores them: they never go back). */
  readonly declines: ClockDeclines;
}

export type ClockPhase = "setup" | "active" | "overdue" | "ended";

export interface GameClockRecord {
  readonly format: typeof CLOCK_FORMAT;
  readonly version: typeof CLOCK_VERSION;
  readonly game_id: string;
  readonly revision: number;
  readonly policy: { readonly class: ClockDeadlineClass; readonly pace_secs: number | null; readonly frozen_at: number | null };
  readonly money: boolean;
  /** CONTINUITY: the authority that last wrote this record, and the last instant it proved it was in control. */
  readonly authority: string;
  readonly trusted_at: number;
  /** The last committed log index folded into this record (-1: none). */
  readonly watermark: number;
  readonly seats: readonly string[];
  readonly phase: ClockPhase;
  readonly obligation: ClockObligation | null;
  readonly parked: readonly ClockParked[];
  readonly overdue: ClockOverdue | null;
  /** Live: each seat's durable ordinary overdue count in this game (never erased: not by a cure, an undo or a pause). */
  readonly strikes: Readonly<Record<string, number>>;
  /** Overdue instances so far (the next is `epochs + 1`). */
  readonly epochs: number;
  readonly proposals_total: number;
  /** Live: the current Operating Round's declines per direction ("from>to"). */
  readonly declines: ClockDeclines;
  readonly pause: ClockPause;
  readonly system: ClockSystemPause | null;
  /** A free table's unanimous neutral annulment in progress. */
  readonly annul: { readonly yes: readonly string[]; readonly at: number } | null;
  /** No undo may reach at or before this index (cures, expiries, pauses, system pauses, a recovered gap). */
  readonly undo_floor: number;
  readonly snapshots: readonly ClockSnapshot[];
  readonly ended: ClockEnded | null;
  readonly remedy: ClockRemedy | null;
  /** No-deadline money tables: player id -> when the disclosure was acknowledged (ms). */
  readonly acks: Readonly<Record<string, number>>;
  readonly evidence: {
    readonly seq: number;
    readonly head: string;
    /** The head before the window (the remedy evidence's `prev_head`). */
    readonly window_from: string;
    readonly window: readonly ClockEvidenceEvent[];
    readonly truncated: boolean;
    /** The strike ledger: every overdue and cure (copies of the chain's own events), never reset by a new obligation;
     *  the newest `CLOCK_LEDGER_LIMIT` kept, `ledger_from` the head before them. */
    readonly ledger_from: string;
    readonly ledger_head: string;
    readonly ledger: readonly ClockEvidenceEvent[];
  };
  readonly created_at: number;
  readonly updated_at: number;
}

/* ==================================================================
    SHAPE CHECKS (a stored clock is exactly this shape, or it is unreadable -- never guessed at, never overwritten)
   ================================================================== */

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const int = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const hex64 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const seat = (value: unknown): value is string => text(value, 64);

const DECISION_KINDS: readonly string[] = ["turn", "auction-bid", "bo-par", "discard", "offer-answer"];
const END_KINDS: readonly string[] = ["game-end", "room-closed", "live-timeout-annul", "live-foreclosure", "live-strike3-foreclosure", "async-annul", "async-foreclosure", "annulled", "escrow-ended"];

function isTimer(value: unknown): value is ClockTimer {
  return isObject(value) && exact(value, ["remaining_ms", "since"]) && time(value.remaining_ms) && (value.since === null || time(value.since));
}

function isObligation(value: unknown): value is ClockObligation {
  if (!isObject(value) || !exact(value, ["seat", "kind", "key", "began_at", "began_index", "initial_ms", "timer", "trade"])) return false;
  if (!seat(value.seat) || !DECISION_KINDS.includes(value.kind as string) || !text(value.key, 200) || !time(value.began_at) || !int(value.began_index) || (value.began_index as number) < -1) return false;
  if (!(value.initial_ms === null || time(value.initial_ms))) return false;
  if (!(value.timer === null || isTimer(value.timer))) return false;
  const trade = value.trade;
  return trade === null || (isObject(trade) && exact(trade, ["proposer", "offer_key"]) && seat(trade.proposer) && text(trade.offer_key, 120));
}

function isVote(value: unknown): value is ClockVote {
  if (!isObject(value) || !exact(value, ["seat", "yes", "at", "approval"]) || !seat(value.seat) || typeof value.yes !== "boolean" || !time(value.at)) return false;
  const approval = value.approval;
  return approval === null || (isObject(approval) && exact(approval, ["approve_until", "signature"]) && time(approval.approve_until) && typeof approval.signature === "string" && /^[0-9a-f]{128}$/.test(approval.signature));
}

function isProposal(value: unknown): value is ClockProposal {
  return (
    isObject(value) &&
    exact(value, ["id", "kind", "by", "at", "votes", "complete_at"]) &&
    time(value.id) &&
    (value.kind === "foreclose" || value.kind === "annul") &&
    seat(value.by) &&
    time(value.at) &&
    Array.isArray(value.votes) &&
    value.votes.length <= 8 &&
    value.votes.every(isVote) &&
    (value.complete_at === null || time(value.complete_at))
  );
}

function isOverdue(value: unknown): value is ClockOverdue {
  return (
    isObject(value) &&
    exact(value, ["epoch", "seat", "strike", "at", "log_len", "log_hash", "decision_kind", "cure", "proposal", "proposals"]) &&
    time(value.epoch) &&
    (value.epoch as number) >= 1 &&
    seat(value.seat) &&
    time(value.strike) &&
    (value.strike as number) <= 3 &&
    time(value.at) &&
    time(value.log_len) &&
    hex64(value.log_hash) &&
    DECISION_KINDS.includes(value.decision_kind as string) &&
    (value.cure === null || isTimer(value.cure)) &&
    (value.proposal === null || isProposal(value.proposal)) &&
    time(value.proposals)
  );
}

function isDeclines(value: unknown): value is ClockDeclines {
  if (!isObject(value) || !exact(value, ["or_key", "counts", "offers"]) || !(value.or_key === null || text(value.or_key, 80)) || !isObject(value.counts)) return false;
  if (Object.keys(value.counts).length > 64 || !Object.entries(value.counts).every(([k, v]) => text(k, 130) && time(v))) return false;
  return Array.isArray(value.offers) && value.offers.length <= 64 && value.offers.every((offer) => text(offer, 200));
}

function isEvidenceEvent(value: unknown): value is ClockEvidenceEvent {
  return isObject(value) && exact(value, ["seq", "kind", "at", "f"]) && time(value.seq) && text(value.kind, 32) && time(value.at) && isObject(value.f);
}

function isRemedy(value: unknown): value is ClockRemedy {
  if (
    !isObject(value) ||
    !exact(value, ["kind", "seat", "strike", "epoch", "log_len", "log_hash", "allowance_secs", "overdue_ms", "final_ms", "approvals", "evidence", "evidence_hash", "sealed_at", "status", "detail", "attestations", "replaces", "stale"])
  ) {
    return false;
  }
  if (![1, 2, 3, 4, 5].includes(value.kind as number) || !seat(value.seat) || !time(value.strike) || !time(value.epoch) || !time(value.log_len) || !hex64(value.log_hash)) return false;
  if (!time(value.allowance_secs) || !time(value.overdue_ms) || !time(value.final_ms) || !hex64(value.evidence_hash) || !time(value.sealed_at) || !time(value.attestations)) return false;
  if (!["sealed", "submitted", "confirmed", "superseded", "refused"].includes(value.status as string)) return false;
  if (!(value.detail === null || (typeof value.detail === "string" && value.detail.length <= 500))) return false;
  if (!(value.replaces === null || [1, 2, 3, 4, 5].includes(value.replaces as number))) return false;
  if (!Array.isArray(value.stale) || value.stale.length > 7 || !value.stale.every(seat)) return false;
  const approvals = value.approvals;
  if (!Array.isArray(approvals) || approvals.length > 7 || !approvals.every((a) => isObject(a) && exact(a, ["seat", "approve_until", "signature"]) && seat(a.seat) && time(a.approve_until) && typeof a.signature === "string" && /^[0-9a-f]{128}$/.test(a.signature))) return false;
  const evidence = value.evidence;
  return (
    isObject(evidence) &&
    exact(evidence, ["format", "game_id", "prev_head", "events", "truncated", "ledger"]) &&
    isObject(evidence.ledger) &&
    exact(evidence.ledger, ["from", "events"]) &&
    hex64(evidence.ledger.from) &&
    Array.isArray(evidence.ledger.events) &&
    evidence.ledger.events.length <= CLOCK_LEDGER_LIMIT &&
    evidence.ledger.events.every(isEvidenceEvent) &&
    evidence.format === "18COSMOS/CLOCK-EVIDENCE/v1" &&
    typeof evidence.game_id === "string" &&
    hex64(evidence.prev_head) &&
    Array.isArray(evidence.events) &&
    evidence.events.length <= CLOCK_EVIDENCE_WINDOW &&
    evidence.events.every(isEvidenceEvent) &&
    typeof evidence.truncated === "boolean"
  );
}

const RECORD_KEYS = [
  "format",
  "version",
  "game_id",
  "revision",
  "policy",
  "money",
  "authority",
  "trusted_at",
  "watermark",
  "seats",
  "phase",
  "obligation",
  "parked",
  "overdue",
  "strikes",
  "epochs",
  "proposals_total",
  "declines",
  "pause",
  "system",
  "annul",
  "undo_floor",
  "snapshots",
  "ended",
  "remedy",
  "acks",
  "evidence",
  "created_at",
  "updated_at",
];

export function isGameClockRecord(value: unknown): value is GameClockRecord {
  if (!isObject(value) || !exact(value, RECORD_KEYS)) return false;
  if (value.format !== CLOCK_FORMAT || value.version !== CLOCK_VERSION) return false;
  if (typeof value.game_id !== "string" || !GAME_ID_PATTERN.test(value.game_id)) return false;
  if (!time(value.revision) || (value.revision as number) < 1) return false;
  const policy = value.policy;
  if (!isObject(policy) || !exact(policy, ["class", "pace_secs", "frozen_at"])) return false;
  if (policy.class === "async-pace" ? !ASYNC_PACES_SECS.includes(policy.pace_secs as number) : policy.pace_secs !== null) return false;
  if (!["live", "async-pace", "no-deadline"].includes(policy.class as string) || !(policy.frozen_at === null || time(policy.frozen_at))) return false;
  if (typeof value.money !== "boolean" || !text(value.authority, 200) || !time(value.trusted_at) || !int(value.watermark) || (value.watermark as number) < -1) return false;
  if (!Array.isArray(value.seats) || value.seats.length > 8 || !value.seats.every(seat)) return false;
  if (!["setup", "active", "overdue", "ended"].includes(value.phase as string)) return false;
  if (!(value.obligation === null || isObligation(value.obligation))) return false;
  if (!Array.isArray(value.parked) || value.parked.length > 8 || !value.parked.every((p) => isObject(p) && exact(p, ["seat", "offer_key", "remaining_ms"]) && seat(p.seat) && text(p.offer_key, 120) && time(p.remaining_ms))) return false;
  if (!(value.overdue === null || isOverdue(value.overdue))) return false;
  if (!isObject(value.strikes) || Object.keys(value.strikes).length > 8 || !Object.entries(value.strikes).every(([k, v]) => seat(k) && time(v) && (v as number) <= 3)) return false;
  if (!time(value.epochs) || !time(value.proposals_total)) return false;
  if (!isDeclines(value.declines)) return false;
  const pause = value.pause;
  if (!isObject(pause) || !exact(pause, ["paused_at", "request", "requests", "window", "resumes"]) || !(pause.paused_at === null || time(pause.paused_at)) || !time(pause.requests)) return false;
  const resumes = pause.resumes;
  if (!isObject(resumes) || !exact(resumes, ["count", "last_at"]) || !time(resumes.count) || !(resumes.last_at === null || time(resumes.last_at))) return false;
  const window = pause.window;
  if (!isObject(window) || !exact(window, ["key", "count"]) || !(window.key === null || text(window.key, 200)) || !time(window.count)) return false;
  const request = pause.request;
  if (!(request === null || (isObject(request) && exact(request, ["id", "kind", "by", "at", "yes"]) && time(request.id) && (request.kind === "pause" || request.kind === "resume") && seat(request.by) && time(request.at) && Array.isArray(request.yes) && request.yes.length <= 8 && request.yes.every(seat)))) return false;
  const system = value.system;
  if (!(system === null || (isObject(system) && exact(system, ["since", "preserved_at", "reason", "yes"]) && time(system.since) && time(system.preserved_at) && text(system.reason, 300) && Array.isArray(system.yes) && system.yes.length <= 8 && system.yes.every(seat)))) return false;
  const annul = value.annul;
  if (!(annul === null || (isObject(annul) && exact(annul, ["yes", "at"]) && Array.isArray(annul.yes) && annul.yes.length <= 8 && annul.yes.every(seat) && time(annul.at)))) return false;
  if (!int(value.undo_floor) || (value.undo_floor as number) < -1) return false;
  if (!Array.isArray(value.snapshots) || value.snapshots.length > CLOCK_SNAPSHOT_LIMIT) return false;
  for (const snap of value.snapshots as unknown[]) {
    if (!isObject(snap) || !exact(snap, ["index", "at", "obligation", "parked", "declines"]) || !time(snap.index) || !time(snap.at) || !(snap.obligation === null || isObligation(snap.obligation)) || !Array.isArray(snap.parked)) return false;
    if (!isDeclines(snap.declines)) return false;
  }
  const ended = value.ended;
  if (!(ended === null || (isObject(ended) && exact(ended, ["kind", "at", "seat"]) && END_KINDS.includes(ended.kind as string) && time(ended.at) && (ended.seat === null || seat(ended.seat))))) return false;
  if (!(value.remedy === null || isRemedy(value.remedy))) return false;
  if (!isObject(value.acks) || Object.keys(value.acks).length > 8 || !Object.entries(value.acks).every(([k, v]) => seat(k) && time(v))) return false;
  const evidence = value.evidence;
  if (!isObject(evidence) || !exact(evidence, ["seq", "head", "window_from", "window", "truncated", "ledger_from", "ledger_head", "ledger"]) || !time(evidence.seq) || !hex64(evidence.head) || !hex64(evidence.window_from)) return false;
  if (!Array.isArray(evidence.window) || evidence.window.length > CLOCK_EVIDENCE_WINDOW || !evidence.window.every(isEvidenceEvent) || typeof evidence.truncated !== "boolean") return false;
  if (!hex64(evidence.ledger_from) || !hex64(evidence.ledger_head) || !Array.isArray(evidence.ledger) || evidence.ledger.length > CLOCK_LEDGER_LIMIT || !evidence.ledger.every(isEvidenceEvent)) return false;
  return time(value.created_at) && time(value.updated_at);
}

/** Why a stored clock could not be read: damaged, an older (v1) or a newer build's format. The game's moves are
 *  unaffected only where the clock is not needed to judge them; the file is left exactly as found. */
export class ClockUnreadableError extends Error {
  constructor(
    message: string,
    readonly gameId: string,
    readonly format: "corrupt" | "older" | "newer" = "corrupt",
  ) {
    super(message);
    this.name = "ClockUnreadableError";
  }
}

/** Classify a stored clock document (every store reads through this). */
export function parseClockDocument(raw: string, gameId: string): GameClockRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ClockUnreadableError(`the clock of ${gameId} is not JSON`, gameId);
  }
  if (isObject(parsed) && parsed.format === CLOCK_FORMAT && typeof parsed.version === "number") {
    if (parsed.version > CLOCK_VERSION) throw new ClockUnreadableError(`the clock of ${gameId} was written by a newer build (version ${parsed.version})`, gameId, "newer");
    if (parsed.version < CLOCK_VERSION) throw new ClockUnreadableError(`the clock of ${gameId} is the provisional version ${parsed.version} (never read by this build)`, gameId, "older");
  }
  /* A record written before the owner-policy correction (2026-10-06) carried the offer budget (`offers`): it never
     entered the evidence or any decision that remains, so it is dropped on read (the record is otherwise the same v2). */
  if (isObject(parsed) && Object.prototype.hasOwnProperty.call(parsed, "offers")) {
    const { offers: _legacy, ...rest } = parsed as Record<string, unknown>;
    void _legacy;
    parsed = rest;
  }
  if (!isGameClockRecord(parsed) || parsed.game_id !== gameId) throw new ClockUnreadableError(`the clock of ${gameId} is not a clock of that game`, gameId);
  return parsed;
}
