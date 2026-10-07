// server/src/conduct/conductClockFacts.ts
//
// ==================================================================
//  PHASE 3 (P3-N035) x FINAL CLOCKS: THE CLOCK FACTS A CONDUCT CASE CARRIES -- READ FROM THE CLOCK LANE, NEVER RE-DERIVED
// ==================================================================
//
// The final clock lane (`rooms/clock/`) is the ONLY authority on who owed what, when an offer froze or charged a clock,
// when a seat went overdue, cured, was struck, voted, paused or was foreclosed. It publishes every such fact twice:
//
//   - as it becomes DURABLE, to the reporting hook (`ClockConductHook`, `clockEvidence.ts`) -- each evidence event with
//     the chain head right after it;
//   - in the table's durable clock record (`GameClockRecord.evidence`): the window of events since the current
//     defaulting obligation began and the never-reset STRIKE LEDGER (every overdue and cure); and, once a remedy is
//     SEALED, in that remedy's own evidence document (`GameClockRecord.remedy.evidence`: the window the seal closed --
//     responsibility, overdue, proposal, votes, veto, consensus, finality, the seal itself -- and its ledger), which the
//     record keeps after it starts a fresh window.
//
// A report reads both and keeps a small, SAFE copy of the most recent facts in the case (`ConductEvidence.clock`, and
// each re-report's own snapshot). Nothing here runs, replays or judges a clock: there is no clock state machine in the
// reporting lane, only a projection of the lane's own evidence events, merged by their chain sequence number.
//
// SAFE means a WHITELIST of flat fields per event: public seat ids, kinds, results, counts, integer times and durations.
// Never carried: a signature or its digest, an approval horizon, a consent or wallet key, a wallet-proof payload, a log
// hash, a ledger head, an internal authority token or any free-text reason / detail (a system pause's reason names this
// server's process authority, so only its structured fields are kept). Free-form strings are kept only when they are
// short codes (`[a-z0-9>:_-]`, at most 48 characters).
//
// BOUNDED: the hook's in-memory feed keeps at most `FEED_EVENTS_PER_GAME` facts per game for at most `FEED_GAMES`
// games (least recently touched dropped first); a case's clock evidence is fitted under `MAX_CLOCK_EVIDENCE_BYTES`,
// keeping the strike ledger first and then the newest events, and says how many it left out.

import type { ClockConductEvidence, ClockConductHook, ClockEvidenceEvent } from "../rooms/clock/clockEvidence";
import type { GameClockRecord } from "../rooms/clock/clockRecord";

/** Per game, the most recent durable clock facts the hook has seen in this process. */
export const FEED_EVENTS_PER_GAME = 96;
/** Games the feed remembers at once (least recently touched first out). */
export const FEED_GAMES = 1_024;
/** A case's clock evidence is fitted under this many bytes of JSON (the case's own bound is `MAX_CLOCK_EVIDENCE_BYTES`). */
export const CONDUCT_CLOCK_BYTES = 7_680;
/** At most this many strike-ledger facts (overdue / cure) are carried; a Live game has at most a handful per seat. */
export const CONDUCT_CLOCK_STRIKES = 24;
/** At most this many recent facts are carried (fewer when the byte bound is reached first). */
export const CONDUCT_CLOCK_EVENTS = 48;

/** The evidence kinds a reviewer of conduct may need (every kind the lane emits; `remedy-status` / `ack` included). */
const KINDS: ReadonlySet<string> = new Set([
  "policy",
  "responsibility",
  "trade-begin",
  "trade-end",
  "overdue",
  "cure",
  "proposal",
  "vote",
  "veto",
  "consensus",
  "pause-request",
  "pause-vote",
  "pause-cancel",
  "paused",
  "resumed",
  "system-pause",
  "system-resume-vote",
  "system-resumed",
  "outage-credited",
  "final",
  "remedy-sealed",
  "remedy-status",
  "undo",
  "annul-vote",
  "ended",
  "ack",
  "vote-stale",
]);

/** The flat fields a conduct fact may carry. Everything else (signature, approve_until, approvals, log_hash,
 *  ledger_head, replaces, detail, key, and every free-text reason) is dropped. */
const SAFE_FIELDS: ReadonlySet<string> = new Set([
  // who
  "seat",
  "proposer",
  "recipient",
  "by",
  "actor",
  "park_seat",
  "seats",
  // what
  "decision",
  "kind",
  "result",
  "outcome",
  "remedy",
  "status",
  "deadline",
  "mode",
  "how",
  "reason",
  "offer",
  "trade",
  "money",
  "yes",
  "stale",
  "again",
  "approvals_valid",
  // counts and ids
  "strike",
  "epoch",
  "id",
  "proposal",
  "declines",
  "index",
  "target",
  "log_len",
  // durations (ms) and times
  "timer_ms",
  "freeze_ms",
  "parked_ms",
  "waited_ms",
  "frozen_ms",
  "charged_ms",
  "freeze_left_ms",
  "remaining_ms",
  "park_ms",
  "park_freeze_ms",
  "allowance_ms",
  "allowance_secs",
  "pace_secs",
  "credited_ms",
  "overdue_ms",
  "final_ms",
  "preserved_at",
  "since",
]);

const CODE = /^[a-z0-9>:_.-]{1,48}$/i;
const SEAT_LIST_LIMIT = 8;

export type ConductClockValue = string | number | boolean | null | readonly string[];

/** One clock fact as a case carries it: the lane's own sequence number, kind and server time, and safe fields. */
export interface ConductClockFact {
  readonly seq: number;
  readonly kind: string;
  readonly at: number;
  readonly f: Readonly<Record<string, ConductClockValue>>;
}

/** A case's clock evidence (`ConductEvidence.clock`, and a re-report's `clock`). */
export interface ConductClockEvidence {
  readonly source: "clock-evidence";
  /** "read": the durable clock record was read; "none": the table has no clock record; "unreadable": it could not be
   *  read when the report was made (only the facts this server saw as they happened are carried). */
  readonly record: "read" | "none" | "unreadable";
  /** The table's deadline class and Timed Async pace (`null`: unknown -- no record). */
  readonly deadline: string | null;
  readonly pace_secs: number | null;
  /** Live strike counts per seat as recorded (public seat ids). */
  readonly strikes: Readonly<Record<string, number>>;
  /** The chain's newest sequence number and head this snapshot knows (`null`: none). */
  readonly seq: number | null;
  readonly head: string | null;
  /** The strike ledger's facts (overdue / cure), oldest first. */
  readonly ledger: readonly ConductClockFact[];
  /** The most recent facts, oldest first. */
  readonly events: readonly ConductClockFact[];
  /** Facts known to this snapshot but left out by its bounds. */
  readonly omitted: number;
}

const safeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

function safeValue(name: string, value: unknown): ConductClockValue | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (safeInt(value)) return value;
  if (typeof value === "string") return CODE.test(value) ? value : undefined;
  if (Array.isArray(value) && name === "seats") {
    const seats = value.filter((item): item is string => typeof item === "string" && CODE.test(item)).slice(0, SEAT_LIST_LIMIT);
    return seats.length === value.length ? seats : undefined;
  }
  return undefined;
}

/** The safe projection of one lane evidence event (`null`: not a conduct fact). */
export function conductClockFactOf(event: ClockEvidenceEvent): ConductClockFact | null {
  if (!safeInt(event.seq) || event.seq < 0 || !safeInt(event.at) || event.at < 0 || !KINDS.has(event.kind)) return null;
  const f: Record<string, ConductClockValue> = {};
  for (const [name, raw] of Object.entries(event.f ?? {})) {
    if (!SAFE_FIELDS.has(name)) continue;
    /* A system pause's `reason` (and any other) is free text naming this server's internals: only a short code is kept. */
    const value = safeValue(name, raw);
    if (value !== undefined) f[name] = value;
  }
  return { seq: event.seq, kind: event.kind, at: event.at, f };
}

/* ==================================================================
    THE FEED: the clock lane's hook, kept per game in this process
   ================================================================== */

export interface ConductClockFeedEntry {
  readonly fact: ConductClockFact;
  readonly head: string;
}

export interface ConductClockFeed {
  /** Give this to the clock controller (`RoomHostClockConfig.conduct`): it never throws and never blocks. */
  readonly hook: ClockConductHook;
  /** The facts seen for a game in this process, oldest first. */
  recent(gameId: string): readonly ConductClockFeedEntry[];
}

export function createConductClockFeed(limits: { readonly perGame?: number; readonly games?: number } = {}): ConductClockFeed {
  const perGame = limits.perGame ?? FEED_EVENTS_PER_GAME;
  const games = limits.games ?? FEED_GAMES;
  const byGame = new Map<string, ConductClockFeedEntry[]>();
  const hook: ClockConductHook = (evidence: ClockConductEvidence) => {
    try {
      const fact = conductClockFactOf(evidence.event);
      if (fact === null || typeof evidence.game_id !== "string" || typeof evidence.head !== "string") return;
      const list = byGame.get(evidence.game_id) ?? [];
      byGame.delete(evidence.game_id); // re-inserted last: least recently touched first out
      if (list.length > 0 && list[list.length - 1].fact.seq >= fact.seq) {
        /* A replayed or reordered event (a retried write): keep one per sequence number, in order. */
        const at = list.findIndex((entry) => entry.fact.seq >= fact.seq);
        if (list[at].fact.seq === fact.seq) list[at] = { fact, head: evidence.head };
        else list.splice(at, 0, { fact, head: evidence.head });
      } else {
        list.push({ fact, head: evidence.head });
      }
      if (list.length > perGame) list.splice(0, list.length - perGame);
      byGame.set(evidence.game_id, list);
      while (byGame.size > games) {
        const oldest = byGame.keys().next().value as string;
        byGame.delete(oldest);
      }
    } catch {
      /* never throws into the clock */
    }
  };
  return {
    hook,
    recent: (gameId) => [...(byGame.get(gameId) ?? [])],
  };
}

/** Both hooks, each guarded: the clock lane's own (if any) and the reporting feed's. */
export function chainClockHooks(first: ClockConductHook | undefined, second: ClockConductHook): ClockConductHook {
  return (evidence) => {
    if (first !== undefined) {
      try {
        first(evidence);
      } catch {
        /* the clock controller guards its hook too */
      }
    }
    second(evidence);
  };
}

/* ==================================================================
    ONE CASE'S CLOCK EVIDENCE: the durable record's window and ledger, and the feed, merged by sequence number
   ================================================================== */

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * The clock evidence for a report made now. `record`: the table's durable clock record (`null`: none; "unreadable": it
 * could not be read). `recent`: the feed's facts for the table. Returns `null` when nothing at all is known (no
 * record and no fact): the case then says the clock was not captured.
 */
export function conductClockEvidenceOf(input: { readonly record: GameClockRecord | null | "unreadable"; readonly recent: readonly ConductClockFeedEntry[]; readonly bytes?: number }): ConductClockEvidence | null {
  const record = input.record === "unreadable" ? null : input.record;
  if (record === null && input.recent.length === 0 && input.record !== "unreadable") return null;
  const bySeq = new Map<number, ConductClockFact>();
  let headSeq: number | null = null;
  let head: string | null = null;
  if (record !== null) {
    /* A sealed remedy's own window first (the seal moved it out of the live window: review finding, consolidated
       integration -- without it a report after a restart or a pool handoff lost the remedy's facts), then the live
       window; one fact per sequence number either way. */
    for (const event of [...(record.remedy?.evidence.events ?? []), ...record.evidence.window]) {
      const fact = conductClockFactOf(event);
      if (fact !== null) bySeq.set(fact.seq, fact);
    }
    headSeq = record.evidence.seq;
    head = record.evidence.head;
  }
  for (const entry of input.recent) {
    bySeq.set(entry.fact.seq, entry.fact);
    if (headSeq === null || entry.fact.seq > headSeq) {
      headSeq = entry.fact.seq;
      head = entry.head;
    }
  }
  const ledgerAll: ConductClockFact[] = [];
  if (record !== null) {
    for (const event of [...(record.remedy?.evidence.ledger.events ?? []), ...record.evidence.ledger]) {
      const fact = conductClockFactOf(event);
      if (fact !== null && !ledgerAll.some((other) => other.seq === fact.seq)) ledgerAll.push(fact);
    }
  }
  for (const fact of bySeq.values()) if ((fact.kind === "overdue" || fact.kind === "cure") && !ledgerAll.some((other) => other.seq === fact.seq)) ledgerAll.push(fact);
  ledgerAll.sort((a, b) => a.seq - b.seq);
  const all = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const strikes: Record<string, number> = {};
  if (record !== null) for (const [seat, n] of Object.entries(record.strikes)) if (CODE.test(seat) && safeInt(n)) strikes[seat] = n;

  const budget = Math.max(1_024, input.bytes ?? CONDUCT_CLOCK_BYTES);
  let ledger = ledgerAll.slice(-CONDUCT_CLOCK_STRIKES);
  let events = all.slice(-CONDUCT_CLOCK_EVENTS);
  const build = (): ConductClockEvidence => ({
    source: "clock-evidence",
    record: input.record === "unreadable" ? "unreadable" : record === null ? "none" : "read",
    deadline: record?.policy.class ?? null,
    pace_secs: record?.policy.pace_secs ?? null,
    strikes,
    seq: headSeq,
    head,
    ledger,
    events,
    omitted: all.length - events.length + (ledgerAll.length - ledger.length),
  });
  let value = build();
  /* Newest first: drop the oldest recent fact, then (only if still too large) the oldest ledger fact. */
  while (bytesOf(value) > budget && (events.length > 0 || ledger.length > 0)) {
    if (events.length > 0) events = events.slice(1);
    else ledger = ledger.slice(1);
    value = build();
  }
  return value;
}

/* ==================================================================
    SHAPE (a stored case's clock evidence is exactly this, or the case is unreadable)
   ================================================================== */

const isObj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function isFact(value: unknown): value is ConductClockFact {
  if (!isObj(value) || Object.keys(value).sort().join(",") !== "at,f,kind,seq") return false;
  if (!safeInt(value.seq) || (value.seq as number) < 0 || !safeInt(value.at) || (value.at as number) < 0 || typeof value.kind !== "string" || !KINDS.has(value.kind)) return false;
  if (!isObj(value.f)) return false;
  return Object.entries(value.f).every(([name, raw]) => SAFE_FIELDS.has(name) && safeValue(name, raw) !== undefined);
}

/** Whether `value` is a clock evidence snapshot this build writes (or `null`). */
export function isConductClockEvidence(value: unknown): value is ConductClockEvidence | null {
  if (value === null) return true;
  if (!isObj(value)) return false;
  const keys = ["deadline", "events", "head", "ledger", "omitted", "pace_secs", "record", "seq", "source", "strikes"];
  if (Object.keys(value).sort().join(",") !== keys.join(",")) return false;
  if (value.source !== "clock-evidence" || !(value.record === "read" || value.record === "none" || value.record === "unreadable")) return false;
  if (!(value.deadline === null || (typeof value.deadline === "string" && CODE.test(value.deadline)))) return false;
  if (!(value.pace_secs === null || safeInt(value.pace_secs))) return false;
  if (!(value.seq === null || safeInt(value.seq)) || !(value.head === null || (typeof value.head === "string" && /^[0-9a-f]{64}$/.test(value.head)))) return false;
  if (!safeInt(value.omitted) || (value.omitted as number) < 0) return false;
  if (!isObj(value.strikes) || !Object.entries(value.strikes).every(([seat, n]) => CODE.test(seat) && safeInt(n))) return false;
  if (!Array.isArray(value.ledger) || value.ledger.length > CONDUCT_CLOCK_STRIKES || !value.ledger.every(isFact)) return false;
  if (!Array.isArray(value.events) || value.events.length > CONDUCT_CLOCK_EVENTS || !value.events.every(isFact)) return false;
  return true;
}
