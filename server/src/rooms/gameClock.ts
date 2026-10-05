// server/src/rooms/gameClock.ts
//
// ==================================================================
//  PHASE 3 LANE A (AUD-11.04 / U-10): THE GAMEPLAY CLOCK -- FACTS, THE DURABLE RECORD, ITS TRANSITIONS, ITS PROJECTION
// ==================================================================
//
// OD-18 (SUPERSEDED IN PART, owner 2026-10-05): BUILD the Live / Async clock before Phase 4 -- infrastructure, visible
// state, pause / resume, durable server-authoritative timing, reconnect / restart behaviour, instrumentation -- and do NOT
// build its consequences: no automatic forfeit, no automatic trade decline, no host succession, no settlement payload.
// This module is therefore CONTROL-PLANE ONLY. It reads the committed board; it never writes the log, never answers a
// move, never touches the GameRecord, the escrow or the settlement seam. A clock at zero is "expired" -- a fact said on
// screen and in an audit line -- and nothing else happens.
//
// WHERE THE CLOCK LIVES (and why not elsewhere):
//   - NOT in the log: a timer entry would be gameplay bytes -- hashed into the settlement commitment, replayed by every
//     client -- for a fact the reducer does not need. The log stays exactly what it was.
//   - NOT in the GameRecord: its schema is exact-keyed and versioned for cross-build continuation (LIVE-4); a new key is
//     an unreadable record to an older build, and an unreadable record is a durable HOLD. The clock must never be able to
//     hold a game.
//   - ITS OWN RECORD: `games/clocks/<game_id>.json` (file stores) / `GAME#<g>/CLOCK` (DynamoDB, fenced like every game
//     write). An older build never reads it; a game without one (every game dealt before this pass) is simply a game
//     whose clock starts when this server first times it.
//
// THE MODEL, in one paragraph. The clock times ONE seat: the seat the engine says is acting (`actingAddress`, the same
// answer `turnAuthority` judges every move by -- the mini-auction's bidder, the Stock Round seat, the operating
// corporation's president). A TURN is a run of committed boards with the same turn key (round type, operating turn,
// acting seat): when the key changes, a new turn starts and its clock starts from zero. Time counts while a turn is
// running and the clock is not paused; it stops for good at GameEnd or when the room closes. The allowance -- how long a
// turn may run before it reads "expired" -- is a per-mode policy slot with NO owner-approved value (`null`: the clock
// counts up and never expires); a table freezes its mode's allowance when its clock starts, so a later configuration
// change never moves a game already being timed (#1256's reason, applied to the clock).
//
// WHAT A RESTART, A RELOAD AND A RECONNECT DO. Nothing a browser does moves the clock: a reconnect, a second tab, a
// reload or a vanished tab only READ the projection. A server restart reads the record back: the same turn (same key)
// keeps its start, its pause and its paused total; a turn the record does not know yet (the last write did not land) is
// started at the hand-over's server stamp -- the other seat's move that began it, durable in the log. An UNDO that reaches
// back into an ended turn resumes that turn with the time it had used (never a fresh allowance); a turn of the same key
// is the same turn only if no other seat has moved since it began. Wall-clock time continues across a restart or a server hold (recorded as a Phase-4 observation item).
//
// INTEGER MILLISECONDS ONLY. Every time here is a safe integer; nothing is a float.

import { promises as nodeFs } from "fs";
import * as path from "path";

import { actingAddress, type GameStateResponse } from "../../../frontend/src/gameEngine/gameState";
import { operatingTurnKey } from "../../../frontend/src/gameEngine/turnGuardKey";
import { revertTargetOf } from "../../../frontend/src/gameEngine/logRevert";
import type { GameMode } from "../../../frontend/src/gameEngine/gameVariants";
import type { RoomClockState, RoomClockView } from "../../../frontend/src/utils/clockProtocol";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { nodeStoreFs, type StoreFs } from "../fileLogStore";
import { durableReplace } from "../persistence/durableReplace";
import { COMMITTED, type StoreWriteOutcome } from "../persistence/storeResult";
import { GAME_ID_PATTERN } from "./gameRecord";

/* ==================================================================
    THE POLICY: TWO SLOTS, NO APPROVED VALUE
   ================================================================== */

/** One mode's clock policy. `turnAllowanceMs: null` -- no owner-approved duration -- counts the turn up, never expires. */
export interface ClockModePolicy {
  readonly turnAllowanceMs: number | null;
}

export interface ClockPolicy {
  readonly live: ClockModePolicy;
  readonly async: ClockModePolicy;
}

/** THE SHIPPED DEFAULT: there is no owner-approved Live or Async duration (Phase 3 lane A, owner decision open). */
export const NO_APPROVED_CLOCK_POLICY: ClockPolicy = Object.freeze({
  live: Object.freeze({ turnAllowanceMs: null }),
  async: Object.freeze({ turnAllowanceMs: null }),
});

/** The owner-gated configuration: whole seconds per turn, per mode. Absent or empty: no duration (the default). */
export const CLOCK_LIVE_TURN_ENV = "GS_CLOCK_LIVE_TURN_SECONDS";
export const CLOCK_ASYNC_TURN_ENV = "GS_CLOCK_ASYNC_TURN_SECONDS";
/** The largest allowance a configuration may name: 366 days (an integer of ms far inside the safe range). */
export const MAX_TURN_ALLOWANCE_SECONDS = 366 * 24 * 60 * 60;

/** The policy from the environment, or why it is refused (a start refuses an unreadable value -- never guesses one). */
export function clockPolicyFromEnv(env: Readonly<Record<string, string | undefined>>): { ok: true; policy: ClockPolicy } | { ok: false; reason: string } {
  const read = (name: string): { ok: true; ms: number | null } | { ok: false; reason: string } => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return { ok: true, ms: null };
    const text = raw.trim();
    if (!/^[1-9][0-9]{0,8}$/.test(text)) return { ok: false, reason: `${name} must be a whole number of seconds (1-${MAX_TURN_ALLOWANCE_SECONDS}), not ${JSON.stringify(raw)}` };
    const seconds = Number(text);
    if (seconds > MAX_TURN_ALLOWANCE_SECONDS) return { ok: false, reason: `${name} is more than ${MAX_TURN_ALLOWANCE_SECONDS} seconds` };
    return { ok: true, ms: seconds * 1000 };
  };
  const live = read(CLOCK_LIVE_TURN_ENV);
  if (!live.ok) return live;
  const asyncSlot = read(CLOCK_ASYNC_TURN_ENV);
  if (!asyncSlot.ok) return asyncSlot;
  return { ok: true, policy: Object.freeze({ live: Object.freeze({ turnAllowanceMs: live.ms }), async: Object.freeze({ turnAllowanceMs: asyncSlot.ms }) }) };
}

/** One line for the startup banner: which slot is set, never an invented value. */
export function describeClockPolicy(policy: ClockPolicy): string {
  const slot = (ms: number | null) => (ms === null ? "no duration (counts up; owner decision open)" : `${ms / 1000} s per turn`);
  return `gameplay clock: Live ${slot(policy.live.turnAllowanceMs)}; Async ${slot(policy.async.turnAllowanceMs)}; expiry has no automatic consequence`;
}

/* ==================================================================
    THE FACTS: WHAT THE COMMITTED BOARD SAYS ABOUT TIMING
   ================================================================== */

/** Read off a committed board (the actor computes these for every view it publishes). Pure; no time in it. */
export interface ClockFacts {
  /** A deal stands (the board seats players). */
  readonly dealt: boolean;
  /** GameEnd. */
  readonly ended: boolean;
  /** CloseRoom applied. */
  readonly closed: boolean;
  /** The acting seat (`actingAddress`: the hosted player id), or `null`. */
  readonly seat: string | null;
  /** Names one turn: the round, the operating turn and the acting seat. `null` when no seat acts. */
  readonly turnKey: string | null;
  /** The committed watermark these facts were read at. */
  readonly watermark: number;
  /** The newest committed entry's server stamp (`at`), or `null` (no entries, or an unstamped legacy entry). */
  readonly lastAt: number | null;
  /** The newest undo that still STANDS (`RevertTo`: everything from `target` up to its own `index` did not happen), or
   *  `null`. A running turn that began inside that range was undone. */
  readonly undo: { readonly target: number; readonly index: number } | null;
  /** The newest STANDING move (non-derived, not an undo, not taken back by one) by a seat OTHER than the acting one, or
   *  -1. A stored turn of the same key is the same turn only if no other seat has moved since the server last saw it
   *  running (Stock Round turns of one seat share a key; an off-turn answer the server saw is vouched for). */
  readonly lastForeignIndex: number;
  /** The server stamp of that move -- the hand-over that began the acting seat's current turn -- or, with none, of the
   *  first entry. The best durable evidence of when the turn began, for a restart that finds no record of it. */
  readonly handoverAt: number | null;
}

export const NO_CLOCK_FACTS: ClockFacts = Object.freeze({ dealt: false, ended: false, closed: false, seat: null, turnKey: null, watermark: -1, lastAt: null, undo: null, lastForeignIndex: -1, handoverAt: null });

const stampOf = (entry: ServerLogEntry | undefined): number | null =>
  entry !== undefined && typeof entry.at === "number" && Number.isSafeInteger(entry.at) && entry.at >= 0 ? entry.at : null;

/** An undo's target (`RevertTo`: an instruction about the log, never a move of the game), or `null`. The text test keeps
 *  the scan from parsing every payload; `revertTargetOf` -- the one definition -- decides. */
const UNDO_TEXT = /^\s*\{\s*"RevertTo"/;
const undoTargetOf = (entry: ServerLogEntry): number | null => (UNDO_TEXT.test(entry.payload) ? revertTargetOf(entry) : null);

/** The facts of a committed board. `board` is the server's own end / close reading (its test seam included). Never
 *  throws: a board that cannot be read is "no turn". */
export function clockFactsOf(input: { readonly state: GameStateResponse; readonly entries: readonly ServerLogEntry[] }, board: { readonly ended: boolean; readonly closed: boolean }): ClockFacts {
  const { state, entries } = input;
  const last = entries.length > 0 ? entries[entries.length - 1] : undefined;
  const watermark = last === undefined ? -1 : last.index;
  const lastAt = stampOf(last);
  let seat: string | null = null;
  let dealt = false;
  try {
    dealt = entries.length > 0 && Array.isArray(state.player_addresses) && state.player_addresses.length > 0;
    seat = dealt && !board.ended && !board.closed ? actingAddress(state, state.waterfall ?? null) : null;
  } catch {
    seat = null;
  }
  if (seat !== null && (typeof seat !== "string" || seat === "")) seat = null;
  const turnKey = seat === null ? null : `${String(state.current_round_type)}|${operatingTurnKey(state)}|${seat}`;
  /* ONE SCAN BACK FROM THE END, over what STANDS -- `effectiveActions`'s rule, read backwards: a standing undo takes back
     every entry from its target up to itself; an undo inside another's range does nothing. It finds the newest standing
     undo and the newest standing move by another seat (normally a step or two away). Every payload is tested as text;
     only an undo's is parsed. */
  const ranges: Array<readonly [number, number]> = [];
  const taken = (index: number) => ranges.some(([target, upTo]) => index >= target && index < upTo);
  let undo: { target: number; index: number } | null = null;
  let lastForeignIndex = -1;
  let handoverAt: number | null = stampOf(entries[0]);
  for (let at = entries.length - 1; at >= 0; at -= 1) {
    const entry = entries[at];
    if (taken(entry.index)) continue;
    const target = undoTargetOf(entry);
    if (target !== null) {
      ranges.push([target, entry.index]);
      if (undo === null) undo = { target, index: entry.index };
      continue;
    }
    if (seat !== null && lastForeignIndex === -1 && entry.derived !== true && entry.actor !== seat) {
      lastForeignIndex = entry.index;
      handoverAt = stampOf(entry) ?? handoverAt;
    }
    if ((seat === null || lastForeignIndex !== -1) && undo !== null) break;
  }
  return Object.freeze({ dealt, ended: board.ended, closed: board.closed, seat, turnKey, watermark, lastAt, undo, lastForeignIndex, handoverAt });
}

/* ==================================================================
    THE DURABLE RECORD
   ================================================================== */

export const CLOCK_FORMAT = "gs-game-clock";
export const CLOCK_VERSION = 1;

/** The turn being timed. */
export interface ClockTurn {
  readonly key: string;
  readonly seat: string;
  /** When it began (server ms). */
  readonly started_at: number;
  /** The committed watermark it began at (diagnostic). */
  readonly from_index: number;
  /** Paused time inside this turn, accrued at each resume (ms). */
  readonly paused_ms: number;
  /** When the server first saw this turn's allowance run out (instrumentation; `null`: not seen). */
  readonly expired_at: number | null;
  /** The newest committed index the server SAW this turn continue through (an off-turn move by another seat -- an offer's
   *  answer, say -- that left the turn where it was). A reload keeps the turn across moves up to here. */
  readonly continued_to: number;
}

/** The standing pause. `since` is the accounting anchor (re-anchored to a turn's start if a turn begins while paused);
 *  `asked_at` and `by` say who paused it and when, for the table and the operator. */
export interface ClockPause {
  readonly since: number;
  readonly asked_at: number;
  /** The player id that paused it (never a principal). */
  readonly by: string;
}

/** A turn that ended, kept so an UNDO that reaches back into it resumes it instead of starting a fresh clock (review
 *  finding 1: without it, undoing the move that ended your turn handed you a whole new allowance). */
export interface ClockPastTurn {
  readonly key: string;
  readonly seat: string;
  readonly from_index: number;
  /** Its active (unpaused) time when it ended. */
  readonly active_ms: number;
}

/** How many ended turns are kept for undo (an undo is the host's or the last mover's, and reaches back a little). */
export const CLOCK_HISTORY_LIMIT = 16;

/** Instrumentation, carried with the record: counted once each, durably. */
export interface ClockTally {
  readonly turns: number;
  readonly pauses: number;
  readonly expiries: number;
}

export interface GameClockRecord {
  readonly format: typeof CLOCK_FORMAT;
  readonly version: typeof CLOCK_VERSION;
  readonly game_id: string;
  /** +1 per change (a store's OCC compares it; a pause / resume binds to it). */
  readonly revision: number;
  /** The table's mode, frozen when its clock started. */
  readonly mode: GameMode;
  /** The turn allowance frozen when its clock started (`null`: no duration). */
  readonly allowance_ms: number | null;
  readonly turn: ClockTurn | null;
  /** The turns before it, newest last (at most `CLOCK_HISTORY_LIMIT`), for undo. */
  readonly history: readonly ClockPastTurn[];
  readonly pause: ClockPause | null;
  /** GameEnd or CloseRoom was observed: nothing is timed any more. */
  readonly stopped_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly tally: ClockTally;
}

const RECORD_KEYS = ["format", "version", "game_id", "revision", "mode", "allowance_ms", "turn", "history", "pause", "stopped_at", "created_at", "updated_at", "tally"];
const PAST_KEYS = ["key", "seat", "from_index", "active_ms"];
const TURN_KEYS = ["key", "seat", "started_at", "from_index", "paused_ms", "expired_at", "continued_to"];
const PAUSE_KEYS = ["since", "asked_at", "by"];
const TALLY_KEYS = ["turns", "pauses", "expiries"];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const count = time;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

/** A stored clock is exactly this shape, or it is unreadable (never guessed at, never overwritten). */
export function isGameClockRecord(value: unknown): value is GameClockRecord {
  if (!isObject(value) || !exact(value, RECORD_KEYS)) return false;
  if (value.format !== CLOCK_FORMAT || value.version !== CLOCK_VERSION) return false;
  if (typeof value.game_id !== "string" || !GAME_ID_PATTERN.test(value.game_id)) return false;
  if (!count(value.revision) || value.revision < 1) return false;
  if (value.mode !== "live" && value.mode !== "async") return false;
  if (!(value.allowance_ms === null || (time(value.allowance_ms) && value.allowance_ms > 0))) return false;
  const turn = value.turn;
  if (
    turn !== null &&
    !(
      isObject(turn) &&
      exact(turn, TURN_KEYS) &&
      text(turn.key, 200) &&
      text(turn.seat, 64) &&
      time(turn.started_at) &&
      Number.isSafeInteger(turn.from_index) &&
      (turn.from_index as number) >= -1 &&
      count(turn.paused_ms) &&
      (turn.expired_at === null || time(turn.expired_at)) &&
      Number.isSafeInteger(turn.continued_to) &&
      (turn.continued_to as number) >= (turn.from_index as number)
    )
  ) {
    return false;
  }
  const history = value.history;
  if (
    !Array.isArray(history) ||
    history.length > CLOCK_HISTORY_LIMIT ||
    !history.every((past) => isObject(past) && exact(past, PAST_KEYS) && text(past.key, 200) && text(past.seat, 64) && Number.isSafeInteger(past.from_index) && (past.from_index as number) >= -1 && count(past.active_ms))
  ) {
    return false;
  }
  const pause = value.pause;
  if (pause !== null && !(isObject(pause) && exact(pause, PAUSE_KEYS) && time(pause.since) && time(pause.asked_at) && text(pause.by, 64))) return false;
  const tally = value.tally;
  if (!(isObject(tally) && exact(tally, TALLY_KEYS) && count(tally.turns) && count(tally.pauses) && count(tally.expiries))) return false;
  return (value.stopped_at === null || time(value.stopped_at)) && time(value.created_at) && time(value.updated_at);
}

/** Why a stored clock could not be read: damaged, or a newer build's format. The game is unaffected; this table's clock
 *  is shown as unavailable and the file is left exactly as found. */
export class ClockUnreadableError extends Error {
  constructor(
    message: string,
    readonly gameId: string,
    readonly newer: boolean = false,
  ) {
    super(message);
    this.name = "ClockUnreadableError";
  }
}

/** Classify a stored clock document (both stores read through this). */
export function parseClockDocument(raw: string, gameId: string): GameClockRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ClockUnreadableError(`the clock of ${gameId} is not JSON`, gameId);
  }
  if (isObject(parsed) && parsed.format === CLOCK_FORMAT && typeof parsed.version === "number" && parsed.version > CLOCK_VERSION) {
    throw new ClockUnreadableError(`the clock of ${gameId} was written by a newer build (version ${parsed.version})`, gameId, true);
  }
  if (!isGameClockRecord(parsed) || parsed.game_id !== gameId) throw new ClockUnreadableError(`the clock of ${gameId} is not a clock of that game`, gameId);
  return parsed;
}

/* ==================================================================
    THE TRANSITIONS (pure)
   ================================================================== */

/** A turn that ended, for the instrumentation line. */
export interface TurnSummary {
  readonly seat: string;
  readonly key: string;
  /** Active (unpaused) time the turn ran. */
  readonly active_ms: number;
  readonly paused_ms: number;
  readonly allowance_ms: number | null;
  readonly expired: boolean;
}

const clampTime = (value: number) => (Number.isSafeInteger(value) && value > 0 ? value : 0);

/** The first record of a table's clock: its mode and that mode's allowance, frozen now. */
export function newClockRecord(gameId: string, mode: GameMode, policy: ClockPolicy, now: number): GameClockRecord {
  return {
    format: CLOCK_FORMAT,
    version: CLOCK_VERSION,
    game_id: gameId,
    revision: 1,
    mode,
    allowance_ms: policy[mode].turnAllowanceMs,
    turn: null,
    history: [],
    pause: null,
    stopped_at: null,
    created_at: now,
    updated_at: now,
    tally: { turns: 0, pauses: 0, expiries: 0 },
  };
}

/** Active time on the current turn at `now`: wall time since it began, less its paused total and any standing pause. */
export function elapsedOf(record: GameClockRecord, now: number): number {
  const turn = record.turn;
  if (turn === null) return 0;
  const end = record.stopped_at ?? (record.pause !== null ? record.pause.since : now);
  return clampTime(Math.min(end, now) - turn.started_at - turn.paused_ms);
}

function summaryOf(record: GameClockRecord, at: number): TurnSummary | null {
  const turn = record.turn;
  if (turn === null) return null;
  const active = elapsedOf(record, at);
  const standing = record.pause !== null ? clampTime(at - record.pause.since) : 0;
  return {
    seat: turn.seat,
    key: turn.key,
    active_ms: active,
    paused_ms: turn.paused_ms + standing,
    allowance_ms: record.allowance_ms,
    expired: record.allowance_ms !== null && active >= record.allowance_ms,
  };
}

/**
 * The record brought in line with the committed board. `since` is when the board's CURRENT turn key was first seen
 * (the keeper's observation time on a live commit; at a load, the newest entry's server stamp). Returns the same record
 * (by identity) when nothing changed, so a caller writes only real changes.
 */
export function observeFacts(record: GameClockRecord, facts: ClockFacts, since: number, now: number): { readonly record: GameClockRecord; readonly ended: TurnSummary | null } {
  const at = Math.min(clampTime(since), now);
  /* GameEnd / CloseRoom: nothing is timed any more. The turn that was running is summed up once. */
  if (facts.ended || facts.closed) {
    if (record.stopped_at !== null) return { record, ended: null };
    const stopAt = Math.max(at, record.turn?.started_at ?? 0);
    const ended = summaryOf(record, stopAt);
    return {
      record: { ...record, revision: record.revision + 1, stopped_at: stopAt, pause: null, updated_at: now, turn: record.turn === null ? null : { ...record.turn } },
      ended,
    };
  }
  /* The same turn: its clock runs on (a reload, a reconnect, a restart, a move inside the turn -- none resets it). The
     key alone does not prove it (one seat's Stock Round turns share a key): it is the same turn only if no other seat
     has moved since it began -- else a turn of another seat came between, however the keeper missed it (a lost write,
     a restart, an older build's interval), and this is a new turn (review finding 2). An undo is never such a move. */
  const turn = record.turn;
  if (record.stopped_at === null && turn !== null && turn.key === facts.turnKey && facts.lastForeignIndex <= turn.continued_to) return { record, ended: null };
  /* No seat acts (dealt, nothing to time): the running turn ends, nothing starts. */
  if (facts.turnKey === null || facts.seat === null) {
    if (turn === null && record.stopped_at === null) return { record, ended: null };
    const ended = record.stopped_at === null ? summaryOf(record, Math.max(at, turn?.started_at ?? 0)) : null;
    return {
      record: { ...record, revision: record.revision + 1, turn: null, history: pushed(record, ended, facts), stopped_at: null, updated_at: now, pause: rebase(record.pause, at) },
      ended,
    };
  }
  /* AN UNDO REACHED BACK INTO AN EARLIER TURN (the live head is below where the running turn began): that turn is
     RESUMED with the active time it had when it ended -- never a fresh allowance (review finding 1), never charged the
     time the undone turn ran. Only a turn this record still remembers can be resumed; anything older starts afresh. */
  if (turn !== null && record.stopped_at === null && undid(facts, turn.from_index)) {
    const target = (facts.undo as { target: number }).target;
    const standing = record.history.filter((past) => past.from_index < target);
    let found = -1;
    for (let at2 = standing.length - 1; at2 >= 0; at2 -= 1) {
      if (standing[at2].key === facts.turnKey) {
        found = at2;
        break;
      }
    }
    if (found !== -1) {
      const past = standing[found];
      const ended = summaryOf(record, Math.max(at, turn.started_at));
      const expired = record.allowance_ms !== null && past.active_ms >= record.allowance_ms;
      return {
        record: {
          ...record,
          revision: record.revision + 1,
          turn: { key: past.key, seat: past.seat, started_at: Math.max(0, at - past.active_ms), from_index: past.from_index, paused_ms: 0, expired_at: expired ? at : null, continued_to: facts.watermark },
          history: standing.slice(0, found),
          pause: rebase(record.pause, at),
          updated_at: now,
        },
        ended,
      };
    }
  }
  /* A new turn: its clock starts from zero at `at` (never before the turn it replaces began). A standing pause carries
     over -- the new turn starts paused -- re-anchored to the turn's start so none of the old pause is charged to it. */
  const startAt = Math.max(at, turn?.started_at ?? 0);
  const ended = record.stopped_at === null ? summaryOf(record, startAt) : null;
  return {
    record: {
      ...record,
      revision: record.revision + 1,
      turn: { key: facts.turnKey, seat: facts.seat, started_at: startAt, from_index: facts.watermark, paused_ms: 0, expired_at: null, continued_to: facts.watermark },
      history: pushed(record, ended, facts),
      pause: rebase(record.pause, startAt),
      stopped_at: null,
      updated_at: now,
      tally: { ...record.tally, turns: record.tally.turns + 1 },
    },
    ended,
  };
}

/** Whether the newest standing undo took back the batch that began a turn at `fromIndex`. (Judged by the undo's own
 *  range, so derived entries the undo's batch appends after it never hide it -- review C.) */
function undid(facts: ClockFacts, fromIndex: number): boolean {
  return facts.undo !== null && fromIndex >= facts.undo.target && fromIndex < facts.undo.index;
}

/** The server saw the running turn continue through `facts` -- another seat moved and the turn did not change (an
 *  offer's answer): it is vouched for up to here, so a reload keeps it (review A). `null` when there is nothing to vouch. */
export function vouchTurn(record: GameClockRecord, facts: ClockFacts, now: number): GameClockRecord | null {
  const turn = record.turn;
  if (record.stopped_at !== null || turn === null || turn.key !== facts.turnKey || facts.lastForeignIndex <= turn.continued_to) return null;
  return { ...record, revision: record.revision + 1, turn: { ...turn, continued_to: Math.max(turn.continued_to, facts.watermark) }, updated_at: now };
}

/** The history with the turn that just ended added (newest last, bounded), less any turn an undo has taken back. */
function pushed(record: GameClockRecord, ended: TurnSummary | null, facts: ClockFacts): readonly ClockPastTurn[] {
  const kept = record.history.filter((past) => !undid(facts, past.from_index));
  const turn = record.turn;
  if (ended === null || turn === null || undid(facts, turn.from_index)) return kept.slice(-CLOCK_HISTORY_LIMIT);
  return [...kept, { key: turn.key, seat: turn.seat, from_index: turn.from_index, active_ms: ended.active_ms }].slice(-CLOCK_HISTORY_LIMIT);
}

function rebase(pause: ClockPause | null, at: number): ClockPause | null {
  return pause === null ? null : { ...pause, since: Math.max(pause.since, at) };
}

/** Why a pause or resume is refused, or `null`. */
export type ClockOpRefusal = { readonly code: "wrong-state"; readonly reason: string } | { readonly code: "clock-stale"; readonly reason: string };

export const CLOCK_STALE_REASON = "The clock changed since this tab last saw it. Check the clock and try again.";
export const CLOCK_NOT_RUNNING_REASON = "No turn is being timed right now.";

/** Pause: the clock stops counting (gameplay is never paused by it). Idempotent: an already paused clock is answered
 *  as it stands. */
export function pauseClock(record: GameClockRecord, by: string, now: number): { readonly record: GameClockRecord } | ClockOpRefusal {
  if (record.stopped_at !== null || record.turn === null) return { code: "wrong-state", reason: CLOCK_NOT_RUNNING_REASON };
  if (record.pause !== null) return { record };
  const since = Math.max(now, record.turn.started_at);
  return {
    record: { ...record, revision: record.revision + 1, pause: { since, asked_at: now, by }, updated_at: now, tally: { ...record.tally, pauses: record.tally.pauses + 1 } },
  };
}

/** Resume: the paused time is added to the turn's paused total, and the clock counts on from what remained. */
export function resumeClock(record: GameClockRecord, now: number): { readonly record: GameClockRecord } | ClockOpRefusal {
  if (record.pause === null) return { record };
  const turn = record.turn;
  const paused = clampTime(now - record.pause.since);
  return {
    record: {
      ...record,
      revision: record.revision + 1,
      pause: null,
      turn: turn === null || record.stopped_at !== null ? turn : { ...turn, paused_ms: turn.paused_ms + paused },
      updated_at: now,
    },
  };
}

/** The server saw the running turn's allowance run out: noted once (instrumentation), nothing else. */
export function noteExpiry(record: GameClockRecord, now: number): GameClockRecord | null {
  const turn = record.turn;
  if (turn === null || record.stopped_at !== null || record.pause !== null || record.allowance_ms === null || turn.expired_at !== null) return null;
  if (elapsedOf(record, now) < record.allowance_ms) return null;
  return { ...record, revision: record.revision + 1, turn: { ...turn, expired_at: now }, updated_at: now, tally: { ...record.tally, expiries: record.tally.expiries + 1 } };
}

/** How long until the running turn's allowance runs out (ms), or `null` when nothing is due (paused, no allowance,
 *  stopped, already noted). */
export function msUntilExpiry(record: GameClockRecord, now: number): number | null {
  const turn = record.turn;
  if (turn === null || record.stopped_at !== null || record.pause !== null || record.allowance_ms === null || turn.expired_at !== null) return null;
  return Math.max(0, record.allowance_ms - elapsedOf(record, now));
}

/* ==================================================================
    THE PROJECTION (`RoomView.clock`)
   ================================================================== */

/** What a viewer is shown. `held`: the room's hold kind (`null`: it takes moves). `record`: `null` before the clock
 *  exists (dealt, not read yet) -- the caller sends no clock then. */
export function clockViewOf(record: GameClockRecord, context: { readonly now: number; readonly held: boolean }): RoomClockView {
  const now = context.now;
  const elapsed = elapsedOf(record, now);
  const remaining = record.allowance_ms === null || record.turn === null ? null : Math.max(0, record.allowance_ms - elapsed);
  let state: RoomClockState;
  if (record.stopped_at !== null) state = "stopped";
  else if (context.held) state = "held";
  else if (record.turn === null) state = "idle";
  else if (record.pause !== null) state = "paused";
  else if (remaining !== null && remaining <= 0) state = "expired";
  else state = "running";
  return {
    mode: record.mode,
    state,
    seat: record.stopped_at === null ? (record.turn?.seat ?? null) : null,
    allowanceMs: record.allowance_ms,
    elapsedMs: elapsed,
    remainingMs: remaining,
    serverNow: now,
    turnStartedAt: record.turn?.started_at ?? null,
    pausedAt: record.pause?.asked_at ?? null,
    revision: record.revision,
  };
}

/** The view of a table whose clock could not be read: its mode only, never a guessed number. */
export function unavailableClockView(mode: GameMode, now: number): RoomClockView {
  return { mode, state: "unavailable", seat: null, allowanceMs: null, elapsedMs: 0, remainingMs: null, serverNow: now, turnStartedAt: null, pausedAt: null, revision: 0 };
}

/* ==================================================================
    THE STORE
   ================================================================== */

/** A table's durable clock. `save` is CONDITIONAL on the stored revision (`expected`: the revision it read; `null`: none
 *  may exist yet) -- a `definite` answer is a conflict or a failure, nothing written. */
export interface ClockStore {
  /** The stored clock, or `null`. Rejects `ClockUnreadableError` for one that cannot be read. */
  load(gameId: string): Promise<GameClockRecord | null>;
  save(record: GameClockRecord, expected: number | null): Promise<StoreWriteOutcome>;
}

/* ---- in memory (tests, and a server with no durable store: the clock then lasts as long as the process) ---- */

export interface MemoryClockStore extends ClockStore {
  readonly clocks: Map<string, GameClockRecord | "unreadable">;
  readonly saves: GameClockRecord[];
  /** Faults for the next saves, in order. */
  readonly failSaves: Array<"definite" | "uncertain-landed" | "uncertain-lost">;
  /** Faults for the next loads, in order. */
  readonly failLoads: Array<"error">;
}

export function createMemoryClockStore(): MemoryClockStore {
  const clocks = new Map<string, GameClockRecord | "unreadable">();
  const saves: GameClockRecord[] = [];
  const failSaves: Array<"definite" | "uncertain-landed" | "uncertain-lost"> = [];
  const failLoads: Array<"error"> = [];
  return {
    clocks,
    saves,
    failSaves,
    failLoads,
    async load(gameId) {
      if (failLoads.shift() === "error") throw new Error("injected clock-store read failure");
      const stored = clocks.get(gameId);
      if (stored === "unreadable") throw new ClockUnreadableError(`the clock of ${gameId} is unreadable`, gameId);
      return stored ?? null;
    },
    async save(record, expected) {
      if (!isGameClockRecord(record)) return { kind: "definite", detail: "not a clock record" };
      const stored = clocks.get(record.game_id);
      if (stored === "unreadable") return { kind: "definite", detail: "the stored clock is unreadable; it is never overwritten" };
      const revision = stored === undefined ? null : stored.revision;
      if (revision !== expected) return { kind: "definite", detail: `the clock moved (stored revision ${revision ?? "none"}, expected ${expected ?? "none"})` };
      const fault = failSaves.shift();
      if (fault === "definite") return { kind: "definite", detail: "injected clock-store failure" };
      if (fault === "uncertain-lost") return { kind: "uncertain", detail: "injected clock-store failure (outcome unknown; not written)" };
      clocks.set(record.game_id, record);
      saves.push(record);
      if (fault === "uncertain-landed") return { kind: "uncertain", detail: "injected clock-store failure (outcome unknown; written)" };
      return COMMITTED;
    },
  };
}

/* ---- the file adapter: `games/clocks/<game_id>.json`, replaced whole and durably ---- */

export interface FileClockStoreOptions {
  fs?: StoreFs;
  platform?: string;
  /** LIVE-3B: every write first checks this process still owns the data directory. */
  writerCheck?: () => Promise<boolean>;
  warn?: (line: string) => void;
}

export function clockDirectory(dataDir: string): string {
  return path.join(dataDir, "games", "clocks");
}

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createFileClockStore(dataDir: string, options: FileClockStoreOptions = {}): ClockStore & { readonly directory: string } {
  const io = options.fs ?? nodeStoreFs;
  const directory = clockDirectory(dataDir);
  // eslint-disable-next-line no-console
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const fileOf = (gameId: string) => path.join(directory, `${gameId}.json`);
  const chains = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const run = (chains.get(key) ?? Promise.resolve()).then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  };

  async function read(gameId: string): Promise<GameClockRecord | null> {
    let raw: Buffer;
    try {
      raw = await io.readFile(fileOf(gameId));
    } catch (error) {
      if (codeOf(error) === "ENOENT") return null;
      throw error;
    }
    return parseClockDocument(raw.toString("utf8"), gameId);
  }

  const fenced = async (): Promise<boolean> => options.writerCheck !== undefined && !(await options.writerCheck().catch(() => false));

  return {
    directory,
    load(gameId) {
      if (!GAME_ID_PATTERN.test(gameId)) return Promise.resolve(null);
      return serial(gameId, () => read(gameId));
    },
    save(record, expected) {
      return serial(record.game_id, async (): Promise<StoreWriteOutcome> => {
        if (!isGameClockRecord(record)) return { kind: "definite", detail: "not a clock record" };
        let stored: GameClockRecord | null;
        try {
          stored = await read(record.game_id);
        } catch (error) {
          /* An unreadable clock is evidence: it is never overwritten (the table's clock stays unavailable). */
          return { kind: "definite", detail: `the stored clock of ${record.game_id} could not be read (${describe(error)}); nothing was written` };
        }
        const revision = stored === null ? null : stored.revision;
        if (revision !== expected) return { kind: "definite", detail: `the clock moved (stored revision ${revision ?? "none"}, expected ${expected ?? "none"})` };
        if (await fenced()) return { kind: "definite", detail: "this server no longer owns the data directory (its lock was taken over); nothing was written" };
        try {
          await io.mkdir(directory);
        } catch (error) {
          return { kind: "definite", detail: `could not make ${directory}: ${describe(error)}` };
        }
        return durableReplace(io, fileOf(record.game_id), Buffer.from(`${JSON.stringify(record)}\n`, "utf8"), { platform: options.platform, warn });
      });
    },
  };
}

/** Read-only, for the operator tool: every stored clock file's game id. */
export async function listClockFiles(dataDir: string): Promise<string[]> {
  try {
    const names = await nodeFs.readdir(clockDirectory(dataDir));
    return names.filter((name) => name.endsWith(".json") && GAME_ID_PATTERN.test(name.slice(0, -5))).map((name) => name.slice(0, -5)).sort();
  } catch (error) {
    if (codeOf(error) === "ENOENT") return [];
    throw error;
  }
}
