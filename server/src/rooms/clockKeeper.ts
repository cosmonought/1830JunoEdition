// server/src/rooms/clockKeeper.ts
//
// ==================================================================
//  PHASE 3 LANE A (AUD-11.04): THE CLOCK KEEPER -- ONE WRITER OF EACH TABLE'S CLOCK, BESIDE (NEVER INSIDE) GAMEPLAY
// ==================================================================
//
// The room host hands the keeper three things and asks it two:
//   load(game)        an actor loaded: read the table's clock back (a restart, an eviction's reload) and bring it in line
//                     with the committed board -- the same turn keeps its start, pause and paused total;
//   observe(facts)    a view was published (the actor's publish, synchronously): if the board's turn changed, the new
//                     turn's clock starts NOW (the moment the server made the board that started it durable and visible);
//   pause / resume    the host's room ops: durable before they are acknowledged, bound to the revision the tab saw;
//   viewOf(game)      the projection every RoomView carries;
//   sweep()           drop what no resident game needs any more.
//
// NOTHING HERE TOUCHES GAMEPLAY. The keeper never queues an actor task, never submits, never appends, never writes a
// GameRecord, a hold, a financial record or an intent, and never calls the escrow or settlement seams. It is told about
// the board after the fact and answers only with its own record and a view. A slow, failing or unreadable clock store
// therefore costs the CLOCK (shown as unavailable, retried, never guessed) and never a move: gameplay does not wait on it.
//
// ONE CHAIN PER TABLE. Every step for a table -- the load, each observation, each op, each expiry note -- runs in order on
// that table's promise chain, so the record is decided by one writer at a time (the store's revision condition, and the
// DynamoDB writer fence, refuse any other).
//
// VISIBLE BEFORE DURABLE, FOR A TURN CHANGE ONLY -- AND WHY THAT IS SAFE. A new turn's start is shown at once, and written
// behind. If the write is lost and the server restarts, the load starts that turn at the newest committed entry's server
// stamp -- the very commit that started it (or a later move inside it): the turn never loses time it was shown to have.
// A PAUSE OR RESUME is different: it is the host's statement, so it is written first and acknowledged (and shown) only
// once the store has it.

import type { GameMode } from "../../../frontend/src/gameEngine/gameVariants";
import type { RoomClockView } from "../../../frontend/src/utils/clockProtocol";
import type { OpsRecorder } from "../persistence/opsRecorder";
import type { StoreWriteOutcome } from "../persistence/storeResult";
import {
  ClockUnreadableError,
  clockViewOf,
  msUntilExpiry,
  newClockRecord,
  noteExpiry,
  observeFacts,
  pauseClock,
  resumeClock,
  unavailableClockView,
  CLOCK_STALE_REASON,
  type ClockFacts,
  type ClockPolicy,
  type ClockStore,
  type GameClockRecord,
  type TurnSummary,
} from "./gameClock";

/** Injected so tests run on controlled time. */
export interface ClockTimers {
  set(fire: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const REAL_CLOCK_TIMERS: ClockTimers = {
  set(fire, ms) {
    const handle = setTimeout(fire, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** A store call that has not answered after this long is treated as uncertain (the clock is reread). */
export const CLOCK_STORE_TIMEOUT_MS = 5_000;
/** Backoff for rereading a clock whose write or read failed. */
export const CLOCK_RETRY_FIRST_MS = 1_000;
export const CLOCK_RETRY_MAX_MS = 60_000;
/** `setTimeout`'s ceiling (an Async allowance can be longer: the timer re-arms). */
const MAX_TIMER_MS = 2 ** 31 - 1;

export const CLOCK_WRITE_FAILED_REASON = "The server could not record that clock change. Try again in a moment.";
export const CLOCK_UNAVAILABLE_REASON = "This table's clock is not available on the server right now.";

export interface ClockKeeperDeps {
  readonly store: ClockStore;
  readonly policy: ClockPolicy;
  now(): number;
  readonly ops: OpsRecorder;
  warn(line: string): void;
  /** The table's clock projection changed: re-send its views. */
  onChange(gameId: string): void;
  /** Whether this process still serves the game (its actor loaded and not retired). A clock of a game it does not is
   *  dropped, never written. */
  serving(gameId: string): boolean;
  readonly timers?: ClockTimers;
  readonly storeTimeoutMs?: number;
}

export type ClockOpAnswer = { readonly ok: true } | { readonly ok: false; readonly code: string; readonly reason: string };

export interface ClockKeeperCounters {
  loads: number;
  turnsStarted: number;
  pauses: number;
  resumes: number;
  expiries: number;
  writes: number;
  writeFailures: number;
  readFailures: number;
  unreadable: number;
  staleOps: number;
}

type Status = "loading" | "ready" | "unavailable";

interface Entry {
  readonly gameId: string;
  mode: GameMode;
  status: Status;
  /** The decided state the table is shown (durable, or a turn start being written behind). */
  record: GameClockRecord | null;
  /** The revision the store is known to hold (`null`: none). */
  stored: number | null;
  /** The newest facts of a SERVED (unheld) committed view. */
  facts: ClockFacts | null;
  /** When `facts.turnKey` was first observed. */
  since: number;
  /** A write or read did not settle: reread the store before the next decision. */
  stale: boolean;
  /** The stored clock cannot be read (damaged / newer build): never written, shown unavailable. */
  unreadable: boolean;
  chain: Promise<void>;
  expiryTimer: unknown | null;
  retryTimer: unknown | null;
  retryMs: number;
  /** +1 per load: a timer armed for an older load does nothing. */
  epoch: number;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createClockKeeper(deps: ClockKeeperDeps) {
  const timers = deps.timers ?? REAL_CLOCK_TIMERS;
  const entries = new Map<string, Entry>();
  const counters: ClockKeeperCounters = { loads: 0, turnsStarted: 0, pauses: 0, resumes: 0, expiries: 0, writes: 0, writeFailures: 0, readFailures: 0, unreadable: 0, staleOps: 0 };
  const now = () => deps.now();

  function enqueue<T>(entry: Entry, step: () => Promise<T>): Promise<T> {
    const run = entry.chain.then(step, step);
    entry.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function bounded<T>(pending: Promise<T>, label: string): Promise<T> {
    const limit = deps.storeTimeoutMs ?? CLOCK_STORE_TIMEOUT_MS;
    let handle: unknown = null;
    const late = new Promise<never>((_resolve, reject) => {
      handle = timers.set(() => reject(new Error(`the clock store did not answer the ${label} within ${limit} ms`)), limit);
    });
    try {
      return await Promise.race([pending, late]);
    } finally {
      timers.clear(handle);
    }
  }

  function clearTimers(entry: Entry): void {
    if (entry.expiryTimer !== null) timers.clear(entry.expiryTimer);
    if (entry.retryTimer !== null) timers.clear(entry.retryTimer);
    entry.expiryTimer = null;
    entry.retryTimer = null;
  }

  function drop(gameId: string): void {
    const entry = entries.get(gameId);
    if (entry === undefined) return;
    clearTimers(entry);
    entry.epoch += 1;
    entries.delete(gameId);
  }

  /** Read the stored clock into the entry. False when it could not be read now (retried later). */
  async function reread(entry: Entry): Promise<boolean> {
    try {
      const stored = await bounded(deps.store.load(entry.gameId), "read");
      entry.record = stored;
      entry.stored = stored === null ? null : stored.revision;
      if (stored !== null) entry.mode = stored.mode;
      entry.status = "ready";
      entry.stale = false;
      entry.unreadable = false;
      entry.retryMs = 0;
      return true;
    } catch (error) {
      if (error instanceof ClockUnreadableError) {
        if (!entry.unreadable) {
          counters.unreadable += 1;
          deps.warn(`  clock: ${entry.gameId}: the stored clock cannot be read (${error.message}); this table's clock is shown unavailable and the file is left exactly as found -- the game is unaffected`);
          deps.ops.audit("clock.unreadable", { game_id: entry.gameId, newer: error.newer });
        }
        entry.unreadable = true;
        entry.status = "unavailable";
        entry.stale = false;
        return false;
      }
      counters.readFailures += 1;
      deps.warn(`  clock: ${entry.gameId}: the clock could not be read just now (${describe(error)}); retrying`);
      entry.status = entry.record === null ? "unavailable" : entry.status;
      entry.stale = true;
      scheduleRetry(entry);
      return false;
    }
  }

  async function write(entry: Entry, record: GameClockRecord): Promise<boolean> {
    let outcome: StoreWriteOutcome;
    try {
      outcome = await bounded(deps.store.save(record, entry.stored), "write");
    } catch (error) {
      outcome = { kind: "uncertain", detail: describe(error) };
    }
    if (outcome.kind === "committed") {
      counters.writes += 1;
      entry.stored = record.revision;
      entry.retryMs = 0;
      return true;
    }
    counters.writeFailures += 1;
    deps.warn(`  clock: ${entry.gameId}: the clock write (revision ${record.revision}) did not land (${outcome.kind}: ${outcome.detail}); rereading before the next change`);
    deps.ops.audit("clock.write-failed", { game_id: entry.gameId, revision: record.revision, outcome: outcome.kind });
    entry.stale = true;
    scheduleRetry(entry);
    return false;
  }

  function scheduleRetry(entry: Entry): void {
    if (entry.retryTimer !== null) return;
    const delay = Math.min(CLOCK_RETRY_MAX_MS, entry.retryMs === 0 ? CLOCK_RETRY_FIRST_MS : entry.retryMs * 2);
    entry.retryMs = delay;
    const epoch = entry.epoch;
    entry.retryTimer = timers.set(() => {
      entry.retryTimer = null;
      if (entry.epoch !== epoch || entries.get(entry.gameId) !== entry) return;
      if (!deps.serving(entry.gameId)) return drop(entry.gameId);
      void enqueue(entry, () => settle(entry, "retry")).catch(() => undefined);
    }, delay);
  }

  function armExpiry(entry: Entry): void {
    if (entry.expiryTimer !== null) {
      timers.clear(entry.expiryTimer);
      entry.expiryTimer = null;
    }
    const record = entry.record;
    if (record === null || entry.status !== "ready") return;
    const due = msUntilExpiry(record, now());
    if (due === null) return;
    const epoch = entry.epoch;
    entry.expiryTimer = timers.set(
      () => {
        entry.expiryTimer = null;
        if (entry.epoch !== epoch || entries.get(entry.gameId) !== entry) return;
        if (!deps.serving(entry.gameId)) return drop(entry.gameId);
        void enqueue(entry, () => expire(entry)).catch(() => undefined);
      },
      Math.min(MAX_TIMER_MS, due + 1),
    );
  }

  function auditTurn(entry: Entry, ended: TurnSummary | null, recovered: boolean): void {
    if (ended === null) return;
    deps.ops.audit("clock.turn", {
      game_id: entry.gameId,
      mode: entry.record?.mode ?? entry.mode,
      seat: ended.seat,
      active_ms: ended.active_ms,
      paused_ms: ended.paused_ms,
      allowance_ms: ended.allowance_ms,
      expired: ended.expired,
      ...(recovered ? { recovered: true } : {}),
    });
  }

  /** Bring the record in line with the newest served facts. `source` says where the turn's start comes from. */
  async function settle(entry: Entry, source: "load" | "commit" | "retry"): Promise<void> {
    if (entries.get(entry.gameId) !== entry) return;
    if (entry.unreadable) return;
    if (entry.stale || entry.status === "loading") {
      if (!(await reread(entry))) return;
    }
    const facts = entry.facts;
    if (facts === null || !facts.dealt) {
      armExpiry(entry);
      return;
    }
    const base = entry.record ?? newClockRecord(entry.gameId, entry.mode, deps.policy, now());
    /* At a load (or a reread), a turn the record does not know starts at the newest committed entry's server stamp --
       the durable evidence of when the board last moved. A live commit's turn starts when it was observed. */
    const since = source === "commit" ? entry.since : Math.min(entry.since, facts.lastAt ?? entry.since);
    const { record: next, ended } = observeFacts(base, facts, since, now());
    if (next === base && entry.record !== null) {
      armExpiry(entry);
      return;
    }
    const startedTurn = next.turn !== null && next.turn !== base.turn && next.turn.key !== base.turn?.key;
    entry.record = next;
    if (startedTurn) counters.turnsStarted += 1;
    auditTurn(entry, ended, source !== "commit");
    if (next.stopped_at !== null && base.stopped_at === null) deps.ops.audit("clock.stopped", { game_id: entry.gameId, at: next.stopped_at });
    armExpiry(entry);
    deps.onChange(entry.gameId);
    await write(entry, next);
  }

  async function expire(entry: Entry): Promise<void> {
    if (entries.get(entry.gameId) !== entry || entry.unreadable) return;
    if (entry.stale && !(await reread(entry))) return;
    const record = entry.record;
    if (record === null) return;
    const next = noteExpiry(record, now());
    if (next === null) {
      armExpiry(entry);
      return;
    }
    /* INSTRUMENTATION ONLY. The turn's allowance ran out: the table is told "Time expired" (the projection already says
       so by its own arithmetic), the operator gets a line, and the record notes it once. No move is made, refused or
       forfeited; no offer is declined; nothing is settled. */
    counters.expiries += 1;
    entry.record = next;
    deps.ops.audit("clock.expired", { game_id: entry.gameId, mode: next.mode, seat: next.turn?.seat ?? null, allowance_ms: next.allowance_ms, turn_started_at: next.turn?.started_at ?? null, at: next.turn?.expired_at ?? null });
    deps.onChange(entry.gameId);
    await write(entry, next);
  }

  async function op(entry: Entry, kind: "pause" | "resume", by: string, revision: number): Promise<ClockOpAnswer> {
    if (entries.get(entry.gameId) !== entry || entry.unreadable) return { ok: false, code: "unavailable", reason: CLOCK_UNAVAILABLE_REASON };
    if (entry.stale && !(await reread(entry))) return { ok: false, code: "unavailable", reason: CLOCK_UNAVAILABLE_REASON };
    if (entry.status !== "ready") return { ok: false, code: "unavailable", reason: CLOCK_UNAVAILABLE_REASON };
    /* The turn a pause names is the board's: an observation queued ahead of this op has already been settled (one chain). */
    const record = entry.record;
    if (record === null) return { ok: false, code: "wrong-state", reason: "No turn is being timed right now." };
    if (record.revision !== revision) {
      counters.staleOps += 1;
      return { ok: false, code: "clock-stale", reason: CLOCK_STALE_REASON };
    }
    const at = now();
    const answer = kind === "pause" ? pauseClock(record, by, at) : resumeClock(record, at);
    if ("code" in answer) return { ok: false, code: answer.code, reason: answer.reason };
    if (answer.record === record) return { ok: true }; // already so: nothing to write (a second tab's double press)
    /* DURABLE BEFORE IT IS ACKNOWLEDGED OR SHOWN. */
    if (!(await write(entry, answer.record))) return { ok: false, code: "unavailable", reason: CLOCK_WRITE_FAILED_REASON };
    entry.record = answer.record;
    if (kind === "pause") counters.pauses += 1;
    else counters.resumes += 1;
    deps.ops.audit(kind === "pause" ? "clock.paused" : "clock.resumed", {
      game_id: entry.gameId,
      by,
      seat: answer.record.turn?.seat ?? null,
      revision: answer.record.revision,
      ...(kind === "resume" ? { turn_paused_ms: answer.record.turn?.paused_ms ?? 0 } : {}),
    });
    armExpiry(entry);
    deps.onChange(entry.gameId);
    return { ok: true };
  }

  function freshEntry(gameId: string, mode: GameMode, previous: Entry | undefined, facts: ClockFacts | null): Entry {
    return {
      gameId,
      mode,
      status: "loading",
      record: null,
      stored: null,
      facts,
      since: now(),
      stale: false,
      unreadable: false,
      chain: previous?.chain ?? Promise.resolve(),
      expiryTimer: null,
      retryTimer: null,
      retryMs: 0,
      epoch: (previous?.epoch ?? 0) + 1,
    };
  }

  return {
    counters,

    /** An actor loaded (a first open, a restart, a reload after eviction). `facts`: its committed view's, `held`: the
     *  view will not take moves (the clock is read, not written). Resolves when the clock has been read and settled. */
    load(gameId: string, input: { readonly mode: GameMode; readonly facts: ClockFacts | null; readonly held: boolean }): Promise<void> {
      counters.loads += 1;
      const previous = entries.get(gameId);
      if (previous !== undefined) clearTimers(previous);
      const entry = freshEntry(gameId, input.mode, previous, input.held ? null : input.facts);
      entry.since = input.facts?.lastAt ?? now();
      entries.set(gameId, entry);
      return enqueue(entry, async () => {
        if (entries.get(gameId) !== entry) return;
        await reread(entry);
        if (entry.status === "ready") await settle(entry, "load");
        deps.onChange(gameId);
      }).catch((error) => deps.warn(`  clock: ${gameId}: the clock load threw -- ${describe(error)}`));
    },

    /** A view was published (synchronously, inside the actor's publish). A held view is not timed: its facts wait. A
     *  table first seen here (its actor loaded before it had a record -- a table created in this process) gets its entry
     *  now; the store is read before anything is decided. */
    observe(gameId: string, facts: ClockFacts | null, held: boolean, mode: GameMode): void {
      if (facts === null || held) return;
      let found = entries.get(gameId);
      if (found === undefined) {
        if (!facts.dealt) return;
        found = freshEntry(gameId, mode, undefined, null);
        entries.set(gameId, found);
      }
      const entry = found;
      if (entry.facts !== null && facts.watermark < entry.facts.watermark) return; // older than what was seen: ignored
      if (entry.facts?.turnKey !== facts.turnKey || entry.facts?.ended !== facts.ended || entry.facts?.closed !== facts.closed) {
        if (entry.facts?.turnKey !== facts.turnKey) entry.since = now();
        entry.facts = facts;
        void enqueue(entry, () => settle(entry, "commit")).catch((error) => deps.warn(`  clock: ${gameId}: a clock update threw -- ${describe(error)}`));
        return;
      }
      entry.facts = facts;
    },

    /** The host's pause (`by`: the host's player id), bound to the revision its tab saw. */
    pause(gameId: string, by: string, revision: number): Promise<ClockOpAnswer> {
      const entry = entries.get(gameId);
      if (entry === undefined) return Promise.resolve({ ok: false, code: "unavailable", reason: CLOCK_UNAVAILABLE_REASON });
      return enqueue(entry, () => op(entry, "pause", by, revision));
    },

    resume(gameId: string, by: string, revision: number): Promise<ClockOpAnswer> {
      const entry = entries.get(gameId);
      if (entry === undefined) return Promise.resolve({ ok: false, code: "unavailable", reason: CLOCK_UNAVAILABLE_REASON });
      return enqueue(entry, () => op(entry, "resume", by, revision));
    },

    /** The projection for a RoomView: `null` before the clock is known (a table not dealt, a clock still loading). */
    viewOf(gameId: string, context: { readonly mode: GameMode; readonly held: boolean; readonly dealt: boolean }): RoomClockView | null {
      if (!context.dealt) return null;
      const entry = entries.get(gameId);
      if (entry === undefined || entry.status === "loading") return null;
      if (entry.unreadable || (entry.status === "unavailable" && entry.record === null)) return unavailableClockView(entry.record?.mode ?? context.mode, now());
      if (entry.record === null) return null;
      return clockViewOf(entry.record, { now: now(), held: context.held });
    },

    /** The record as the keeper holds it (tests and the operator's view). */
    recordOf(gameId: string): GameClockRecord | null {
      return entries.get(gameId)?.record ?? null;
    },

    /** Every step queued for this table has run (tests). */
    settled(gameId: string): Promise<void> {
      return entries.get(gameId)?.chain ?? Promise.resolve();
    },

    /** Drop the clocks of games this process no longer serves (the room host's periodic sweep). */
    sweep(): void {
      for (const gameId of [...entries.keys()]) if (!deps.serving(gameId)) drop(gameId);
    },

    drop,

    /** Stop every timer (server close). */
    close(): void {
      for (const gameId of [...entries.keys()]) drop(gameId);
    },

    size(): number {
      return entries.size;
    },
  };
}

export type ClockKeeper = ReturnType<typeof createClockKeeper>;
