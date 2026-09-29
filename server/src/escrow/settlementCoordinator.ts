// server/src/escrow/settlementCoordinator.ts
//
// ==================================================================
//  ESCROW-3A (brief §4-§6): THE SETTLEMENT SEAM, MADE DURABLE, IDEMPOTENT AND CRASH-SAFE
// ==================================================================
//
// LIVE-3C's `SettlementLifecycle.onGameplayClosed` is AT LEAST ONCE: the completing commit announces the seal, and every
// later load of a completed game announces it again (`recovered: true`), because the in-memory call can be lost to a
// crash after the record is durable. This is the money side of that seam. It turns every announcement into durable state
// keyed by the ONE identity of a terminal history -- `(gameId, seal.log_len)` -- so any number of announcements converge
// on one record, and it never relies on the announcement having happened:
//
//   announcement (sync, inside a publish; never throws, never awaits)
//     -> the sealed prefix is cut at once (`sealedPrefix`: nothing appended after the seal is kept)
//     -> a job is queued; the queue is drained OUTSIDE the publish:
//          0. `dealt`     a sealed game was dealt: a record still at `funding` moves to in-progress first (the deal is
//                         derived from the gameplay authority -- the GameRecord's log-implied `started_at` -- never
//                         remembered from an event that a crash could lose);
//          1. `sealed`    the financial record moves in-progress -> terminal-eligible with `terminal: {log_len, ...}`
//                         (compare-and-swap; the same seal again is `same`; another `log_len` HOLDS: two histories);
//          2. continuation: may THIS deployment interpret the game at all (`moneyContinuation.ts`)? else HOLD;
//          3. `prepared`  the evidence is derived from exactly the sealed prefix (`settlementEvidence.ts`) and recorded
//                         -> intent-prepared; a board that cannot settle (uncertified pin, appraisal refusal, a prefix
//                         that does not replay) HOLDS instead;
//     a store failure leaves the job queued and retries it on a timer (backoff), so a thrown or failed step is retried
//     safely -- every step is a transition from the record as it now is.
//
// CRASH-SAFE DISCOVERY (brief §6). A completed money game must not need a player to reopen it. At startup
// `reconcileAtStartup` walks the financial records (and every GameRecord the host says is financial) and LOADS each one
// that is not yet `intent-prepared` -- the load is LIVE-3C's reconciliation, and a completed game's load announces its
// seal again -- then drains. The four cases converge:
//   crash after GameEnd, before any intent   the financial record says in-progress; the startup load re-announces; 1-3 run;
//   crash after the intent was written       the record is already terminal-eligible/intent-prepared with this log_len:
//                                            the re-announcement is `same`; nothing is created twice;
//   a failed or thrown step                  retried from the durable record, on a timer and at the next start;
//   nobody ever reconnects                   the startup walk loads the game itself.
// Only financial games are loaded: archived and ordinary games are never replayed for this.
//
// Money games are DISABLED (`record.money === null` everywhere), so in production `isFinancial` is false for every game
// and this coordinator does nothing but exist; its behaviour is pinned by `settlementLifecycle.test.ts` through a
// financial predicate the test supplies. ESCROW-3B plugs signing and broadcast in after `intent-prepared`.

import type { GameRecord } from "../rooms/gameRecord";
import { sealedPrefix, SealedPrefixError, type RetentionClass, type SettlementLifecycle, type TerminalSeal, FINANCIAL_RETENTION_REASON } from "../rooms/lifecycle";
import type { OpsRecorder } from "../persistence/opsRecorder";
import type { ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { FinancialRecordUnreadableError, type FinancialGameStore } from "./financialGameStore";
import { moneyContinuationVerdict, THIS_DEPLOYMENT, type DeploymentContinuation, type MoneyContinuationFacts, type MoneyContinuationIdentity, type MoneyIndexEntry } from "./moneyContinuation";
import { missingRecordPlaceholder, transitionFinancial, type FinancialDeploymentPin, type FinancialEvent, type FinancialGameRecord } from "./moneyLifecycle";
import { prepareTerminalEvidence, type PrefixReplay } from "./settlementEvidence";

export interface SettlementCoordinatorDeps {
  readonly store: FinancialGameStore;
  /** Is this game a money game? Production: `record.money !== null` (always false while money games are disabled). */
  readonly isFinancial?: (record: Readonly<GameRecord>) => boolean;
  readonly replay: PrefixReplay;
  readonly now: () => number;
  readonly warn: (line: string) => void;
  readonly ops?: OpsRecorder;
  readonly deployment?: DeploymentContinuation;
  /** First retry after a failed step (doubling to `maxRetryMs`). */
  readonly retryMs?: number;
  readonly maxRetryMs?: number;
  /** Timer seam (tests drive `drain()` themselves and may pass a no-op). */
  readonly schedule?: (run: () => void, ms: number) => { cancel(): void };
  /** ESCROW-3B: the terminal intent is prepared (or found prepared again): the escrow service signs and submits from
   *  it. At least once; the service is idempotent by slot. Must not throw. */
  readonly onIntentPrepared?: (gameId: string) => void;
}

interface Job {
  readonly gameId: string;
  readonly seal: TerminalSeal;
  /** The GameRecord's deal time (a sealed game was dealt), for a record still at `funding`. */
  readonly dealtAt: number | null;
  /** The sealed prefix, or why the history could not be cut. */
  readonly prefix: readonly ServerLogEntry[] | { readonly refused: string };
  attempts: number;
}

export interface StartupReconciliation {
  readonly financialGames: number;
  readonly loaded: number;
  readonly alreadyPrepared: number;
  readonly failed: ReadonlyArray<{ readonly gameId: string; readonly reason: string }>;
}

/* LIVE-4 (L4-2): THE COORDINATOR IS THE MONEY FACTS' INDEX (`MoneyContinuationFacts`). It already read every financial
   record at startup and kept each game's continuation identity current through every write; it now also keeps the
   write-once deployment pin, whether the record is ESCROW-3A's held placeholder, and which records it could not read --
   read-only facts the canonical verdict judges at every rebuild of a game's session. `refresh` reads one record again
   (a money table's record is written by the escrow service before its GameRecord exists). No transition, hold or write
   is added here: what a verdict concludes is written by L4-4, not by this index. */
export interface SettlementCoordinator extends SettlementLifecycle, MoneyContinuationFacts {
  /** Run every queued job now; resolves when the queue is empty or every remaining job is waiting on a retry. */
  drain(): Promise<void>;
  /** Jobs queued or waiting to retry. */
  pending(): number;
  /** The stored continuation identity of a money game (loaded by `load`, kept current by every write). */
  continuationOf(gameId: string): MoneyContinuationIdentity | undefined;
  /** Read every financial record's continuation identity (before the server serves anything). */
  load(): Promise<void>;
  /** Brief §6: load every financial game that is not yet settled-to-intent, so a completed one is announced even when
   *  nobody reopens it. `loadGame` is the room host's ordinary load (LIVE-3C's reconciliation). */
  reconcileAtStartup(input: { readonly financialGameIds: readonly string[]; readonly loadGame: (gameId: string) => Promise<unknown> }): Promise<StartupReconciliation>;
  /** A periodic look at quiet funded games (liveness is a state, never a refund). */
  sweepLiveness(records: Iterable<Readonly<GameRecord>>): Promise<void>;
  stop(): void;
  readonly stats: { announced: number; sealed: number; prepared: number; held: number; repeats: number; retries: number; failures: number };
}

const defaultSchedule = (run: () => void, ms: number) => {
  const handle = setTimeout(run, ms);
  (handle as { unref?: () => void }).unref?.();
  return { cancel: () => clearTimeout(handle) };
};

export function createSettlementCoordinator(deps: SettlementCoordinatorDeps): SettlementCoordinator {
  /** ESCROW-3B: every game with a financial record (loaded at startup, kept by every write): a money game is known by
   *  its durable financial record, so lifecycle tooling never archives it even while its GameRecord's `money` seam is
   *  null (ESCROW-4 widens the GameRecord). */
  const known = new Set<string>();
  const isFinancial = deps.isFinancial ?? ((record: Readonly<GameRecord>) => record.money !== null || known.has(record.game_id));
  const deployment = deps.deployment ?? THIS_DEPLOYMENT;
  const schedule = deps.schedule ?? defaultSchedule;
  const retryBase = deps.retryMs ?? 5_000;
  const retryMax = deps.maxRetryMs ?? 5 * 60_000;
  const stats = { announced: 0, sealed: 0, prepared: 0, held: 0, repeats: 0, retries: 0, failures: 0 };
  /** Queued jobs by `${gameId}#${log_len}`: repeated announcements of one terminal history are ONE job. */
  const jobs = new Map<string, Job>();
  const continuations = new Map<string, MoneyContinuationIdentity>();
  /* LIVE-4 (L4-2): the rest of the money facts (see `SettlementCoordinator`). */
  const deployments = new Map<string, FinancialDeploymentPin | null>();
  const placeholders = new Set<string>();
  const unreadable = new Map<string, string>();
  let timer: { cancel(): void; due: number } | null = null;
  let draining: Promise<void> | null = null;
  let stopped = false;

  const keyOf = (gameId: string, logLen: number) => `${gameId}#${logLen}`;

  const notifyPrepared = (gameId: string) => {
    try {
      deps.onIntentPrepared?.(gameId);
    } catch (error) {
      deps.warn(`  settlement: the escrow service's prepared hook threw for ${gameId} -- ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** Schedule a pass in `ms` -- or sooner, never later: a new seal is not left waiting behind a failing job's backoff. */
  function kick(ms: number): void {
    if (stopped) return;
    const due = Date.now() + ms;
    if (timer !== null) {
      if (timer.due <= due) return;
      timer.cancel();
      timer = null;
    }
    const scheduled: { cancel(): void; due: number } = { cancel: () => undefined, due };
    timer = scheduled;
    const handle = schedule(() => {
      if (timer === scheduled) timer = null;
      void drain();
    }, ms);
    scheduled.cancel = () => handle.cancel();
  }

  /** The stored continuation identity -- none for a placeholder (unknown: nothing continues on its account). LIVE-4
   *  (L4-2): and the rest of its money facts. */
  const remember = (record: FinancialGameRecord) => {
    known.add(record.game_id);
    unreadable.delete(record.game_id);
    if (record.continuation === null) {
      continuations.delete(record.game_id);
      deployments.delete(record.game_id);
      placeholders.add(record.game_id);
    } else {
      continuations.set(record.game_id, record.continuation);
      deployments.set(record.game_id, record.binding?.deployment ?? null);
      placeholders.delete(record.game_id);
    }
  };

  /** One transition, written by compare-and-swap; a stale view re-decides from the stored record (3 attempts). */
  async function apply(gameId: string, event: (record: FinancialGameRecord) => FinancialEvent): Promise<{ ok: true; record: FinancialGameRecord; changed: boolean } | { ok: false; reason: string }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let record: FinancialGameRecord | null;
      try {
        record = await deps.store.load(gameId);
      } catch (error) {
        return { ok: false, reason: error instanceof FinancialRecordUnreadableError ? error.message : `the financial record could not be read (${String(error)})` };
      }
      if (record === null) {
        /* A money GameRecord whose financial record is missing: ESCROW-3B writes both together, so this is never guessed
           at. ONE create-if-absent writes a placeholder ALREADY HELD, with no continuation identity (a racing creation
           converges on whichever landed; nothing is invented, and nothing is left unheld between two writes). */
        const placeholder = missingRecordPlaceholder(gameId, deps.now(), "a money game had no financial record when the settlement seam looked for it");
        const outcome = await deps.store.create(placeholder);
        if (outcome.outcome.kind !== "committed") return { ok: false, reason: outcome.outcome.detail };
        if (outcome.existing === null) {
          continuations.delete(gameId);
          /* LIVE-4 (L4-2): the index says so too (it is exactly what `remember` would note of the placeholder). */
          deployments.delete(gameId);
          unreadable.delete(gameId);
          placeholders.add(gameId);
          stats.held += 1;
          deps.ops?.audit("settlement.held", { game_id: gameId, code: "financial-record-missing" });
          deps.warn(`  settlement: ${gameId} is a money game with no financial record; a held placeholder was written -- restore the original record`);
          return { ok: true, record: placeholder, changed: true };
        }
        continue;
      }
      remember(record);
      const decided = transitionFinancial(record, event(record));
      if (decided.kind === "same") return { ok: true, record, changed: false };
      if (decided.kind === "refused") return { ok: true, record, changed: false };
      const put = await deps.store.put(decided.next, record.record_version);
      if (put.kind === "committed") {
        if (decided.next.phase === "held" && record.phase !== "held") {
          stats.held += 1;
          deps.ops?.audit("settlement.held", { game_id: gameId, code: decided.next.hold?.code ?? null, from: record.phase });
        }
        return { ok: true, record: decided.next, changed: true };
      }
      if (put.kind === "conflict") continue; // another writer moved it: decide again from what it wrote
      return { ok: false, reason: put.detail };
    }
    return { ok: false, reason: "the financial record kept changing under three attempts" };
  }

  async function runJob(job: Job): Promise<"done" | "retry"> {
    const at = deps.now();
    /* 0. A sealed game was dealt: a record still at `funding` moves to in-progress (anything else: no write). */
    const dealt = await apply(job.gameId, () => ({ kind: "dealt", at: job.dealtAt ?? job.seal.at }));
    if (!dealt.ok) {
      deps.warn(`  settlement: ${job.gameId} could not be read or moved past funding -- ${dealt.reason}; retrying`);
      return "retry";
    }
    /* 1. The seal -- or, if the history could not be cut, a hold (never a guess at a prefix). */
    if (!Array.isArray(job.prefix)) {
      const refused = (job.prefix as { refused: string }).refused;
      const held = await apply(job.gameId, () => ({ kind: "hold", at, code: "sealed-prefix-refused", detail: refused }));
      return held.ok ? "done" : "retry";
    }
    const sealed = await apply(job.gameId, () => ({ kind: "sealed", at, log_len: job.seal.log_len, sealed_at: job.seal.at }));
    if (!sealed.ok) {
      deps.warn(`  settlement: ${job.gameId} (log_len ${job.seal.log_len}) could not be recorded -- ${sealed.reason}; retrying`);
      return "retry";
    }
    if (sealed.changed && sealed.record.phase === "terminal-eligible") {
      stats.sealed += 1;
      deps.ops?.audit("settlement.sealed", { game_id: job.gameId, log_len: job.seal.log_len, sealed_at: job.seal.at });
    } else if (!sealed.changed) {
      stats.repeats += 1;
    }
    const record = sealed.record;
    if (record.phase === "intent-prepared" && record.terminal?.log_len === job.seal.log_len) notifyPrepared(job.gameId); // at least once
    if (record.phase !== "terminal-eligible" || record.terminal?.log_len !== job.seal.log_len) return "done"; // held, prepared, or another seal
    /* 2. May this deployment interpret the game? */
    const verdict = moneyContinuationVerdict(record.continuation, deployment);
    if (!verdict.continues) {
      const held = await apply(job.gameId, () => ({ kind: "hold", at: deps.now(), code: "continuation-incompatible", detail: `${verdict.why}: ${verdict.detail}` }));
      return held.ok ? "done" : "retry";
    }
    /* 3. The evidence, from exactly the sealed prefix. */
    const prepared = prepareTerminalEvidence({ gameId: job.gameId, entries: job.prefix as readonly ServerLogEntry[], seal: job.seal, replay: deps.replay });
    const next = await apply(job.gameId, () =>
      prepared.ok ? { kind: "prepared", at: deps.now(), evidence: prepared.evidence } : { kind: "hold", at: deps.now(), code: prepared.code, detail: prepared.detail },
    );
    if (!next.ok) return "retry";
    if (prepared.ok && next.changed && next.record.phase === "intent-prepared") {
      stats.prepared += 1;
      deps.ops?.audit("settlement.intent-prepared", { game_id: job.gameId, log_len: prepared.evidence.log_len, log_hash: prepared.evidence.log_hash, appraisal_state_hash: prepared.evidence.appraisal_state_hash, rules_engine_version: prepared.evidence.rules_engine_version });
    }
    if (next.record.phase === "intent-prepared") notifyPrepared(job.gameId);
    return "done";
  }

  function drain(): Promise<void> {
    if (draining !== null) return draining;
    const run = (async () => {
      const attempted = new Set<string>();
      {
        let delay: number | null = null;
        for (const [key, job] of [...jobs]) {
          attempted.add(key);
          let result: "done" | "retry";
          try {
            result = await runJob(job);
          } catch (error) {
            stats.failures += 1;
            deps.warn(`  settlement: a step for ${job.gameId} threw -- ${error instanceof Error ? error.message : String(error)}; retrying`);
            result = "retry";
          }
          if (result === "done") {
            if (jobs.get(key) === job) jobs.delete(key);
          } else {
            job.attempts += 1;
            stats.retries += 1;
            const wait = Math.min(retryMax, retryBase * 2 ** Math.min(job.attempts - 1, 10));
            delay = delay === null ? wait : Math.min(delay, wait);
          }
        }
        if (delay !== null) kick(delay);
        /* A job announced while this pass ran is not in its snapshot: run another pass for it. */
        if ([...jobs.keys()].some((key) => !attempted.has(key))) kick(0);
      }
    })();
    /* Set BEFORE the pass can finish (a pass with nothing to await finishes synchronously), cleared after. */
    draining = run;
    void run.then(
      () => {
        if (draining === run) draining = null;
      },
      () => {
        if (draining === run) draining = null;
      },
    );
    return run;
  }

  const coordinator: SettlementCoordinator = {
    stats,
    onGameplayClosed(input) {
      if (!isFinancial(input.record)) return;
      stats.announced += 1;
      const key = keyOf(input.gameId, input.seal.log_len);
      if (jobs.has(key)) {
        stats.repeats += 1;
        return; // the same terminal history, already queued
      }
      let prefix: Job["prefix"];
      try {
        prefix = sealedPrefix(input.entries, input.seal).prefix;
      } catch (error) {
        prefix = { refused: error instanceof SealedPrefixError ? error.message : String(error) };
      }
      jobs.set(key, { gameId: input.gameId, seal: { log_len: input.seal.log_len, at: input.seal.at }, dealtAt: input.record.started_at, prefix, attempts: 0 });
      kick(0);
    },
    retentionOf(record): RetentionClass {
      return record.money === null && !isFinancial(record) ? { kind: "no-money" } : { kind: "financial", reason: FINANCIAL_RETENTION_REASON };
    },
    drain,
    pending: () => jobs.size,
    continuationOf: (gameId) => continuations.get(gameId),
    /* LIVE-4 (L4-2): the money facts, as the canonical verdict reads them (`MoneyContinuationFacts`). */
    factsOf(gameId): MoneyIndexEntry | undefined {
      const broken = unreadable.get(gameId);
      if (broken !== undefined) return { kind: "unreadable", detail: broken };
      if (placeholders.has(gameId)) return { kind: "placeholder" };
      const mci = continuations.get(gameId);
      return mci === undefined ? undefined : { kind: "record", mci, deployment: deployments.get(gameId) ?? null };
    },
    async refresh(gameId) {
      try {
        const record = await deps.store.load(gameId);
        if (record !== null) remember(record);
      } catch (error) {
        /* A record already known keeps what was read of it (its identity and pin are write-once; a read that failed
           just now changes neither). One never read is kept as a fact, not guessed at: unreadable, so no pool
           continues it (derived). */
        if (!continuations.has(gameId) && !placeholders.has(gameId)) unreadable.set(gameId, error instanceof Error ? error.message : String(error));
      }
    },
    async load() {
      for (const gameId of await deps.store.list()) {
        known.add(gameId);
        try {
          const record = await deps.store.load(gameId);
          if (record !== null) remember(record);
        } catch (error) {
          /* LIVE-4 (L4-2): noted for the verdict too (the game's financial artifact is unreadable: never continued). */
          unreadable.set(gameId, error instanceof Error ? error.message : String(error));
          deps.warn(`  settlement: the financial record of ${gameId} cannot be read -- ${error instanceof Error ? error.message : String(error)}; it is not continued anywhere`);
        }
      }
    },
    async reconcileAtStartup(input) {
      const ids = new Set<string>([...input.financialGameIds, ...(await deps.store.list())]);
      let loaded = 0;
      let alreadyPrepared = 0;
      const failed: Array<{ gameId: string; reason: string }> = [];
      for (const gameId of [...ids].sort()) {
        let record: FinancialGameRecord | null = null;
        try {
          record = await deps.store.load(gameId);
        } catch (error) {
          failed.push({ gameId, reason: error instanceof Error ? error.message : String(error) });
          continue;
        }
        if (record !== null) remember(record);
        /* Settled to intent, or cancelled before the deal: nothing to discover by loading it. A `funding` record IS
           loaded -- its game may have been dealt and even completed while nothing moved the record (the load
           re-announces a seal; the sweep derives the deal). Only financial games are ever walked. */
        if (record !== null && (record.phase === "intent-prepared" || record.phase === "cancelled")) {
          if (record.phase === "intent-prepared") alreadyPrepared += 1;
          continue;
        }
        try {
          await input.loadGame(gameId); // LIVE-3C's load: reconciles, and re-announces a completed game's seal
          loaded += 1;
        } catch (error) {
          failed.push({ gameId, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      await drain();
      return { financialGames: ids.size, loaded, alreadyPrepared, failed };
    },
    async sweepLiveness(records) {
      for (const record of records) {
        if (!isFinancial(record)) continue;
        /* The deal, derived from the GameRecord (log-implied `started_at`): a record still at funding moves first. */
        if (record.started_at !== null) await apply(record.game_id, () => ({ kind: "dealt", at: record.started_at as number }));
        await apply(record.game_id, (stored) =>
          record.last_activity_at > (stored.last_activity_at ?? 0) ? { kind: "activity", at: record.last_activity_at } : { kind: "inactivity-check", at: deps.now() },
        );
      }
    },
    stop() {
      stopped = true;
      timer?.cancel();
      timer = null;
    },
  };
  return coordinator;
}
