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
//     -> the sealed prefix is cut at once (`sealedPrefix`: nothing appended after the seal is kept), and the deal's
//        identity is read from the entries (`gameIdentityOfEntries`)
//     -> a job is queued; the queue is drained OUTSIDE the publish:
//         -1. VERDICT     LIVE-4 (L4-4), BEFORE ANY WRITE: may THIS pool act on the game at all? The canonical
//                         continuation verdict (`moneyServing.ts`) over the financial record (its class, its money
//                         identity, its deployment), the ticket ledger's and chain intents' classes (the escrow
//                         service's), the deal's identity, this pool's capability and the chain's
//                         verification-grade facts. Not continued here -- another deployment's game, one this pool
//                         cannot verify yet, another build's format, a protocol it does not speak -- writes NOTHING (no
//                         deal, no seal, no hold: the pool that serves it seals it) and is noticed once. A conflict is
//                         held under its canonical code, by the OWNING pool only; a MISSING financial record is that
//                         conflict, and only the owner (the pool serving the deployment the GameRecord's money terms
//                         name) writes ESCROW-3A's held placeholder, once. (Before L4-4, steps 0-1 wrote first and a
//                         failed verdict was a durable `continuation-incompatible` hold: F-L4-3.)
//          0. `dealt`     a sealed game was dealt: a record still at `funding` moves to in-progress first (the deal is
//                         derived from the gameplay authority -- the GameRecord's log-implied `started_at` -- never
//                         remembered from an event that a crash could lose);
//          1. `sealed`    the financial record moves in-progress -> terminal-eligible with `terminal: {log_len, ...}`
//                         (compare-and-swap; the same seal again is `same`; another `log_len` HOLDS: two histories);
//          2. (continuation: folded into step -1, which asks the same money identity by set membership, and more);
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
import { gameIdentityOfEntries, type GameIdentityFacts } from "../../../frontend/src/gameEngine/compat/continuationIdentity";
import type { FormatFact } from "../../../frontend/src/gameEngine/compat/continuationVerdict";
import { FinancialRecordUnreadableError, type FinancialGameStore } from "./financialGameStore";
import type { MoneyContinuationFacts, MoneyContinuationIdentity, MoneyIndexEntry } from "./moneyContinuation";
import { missingRecordPlaceholder, transitionFinancial, type FinancialEvent, type FinancialGameRecord } from "./moneyLifecycle";
import { classifiesArtifacts, moneyFactsOf, moneyTermsKey, noMoneyServing, type ArtifactClasses, type MoneyGameFacts, type MoneyServing, type MoneyServingDecision } from "./moneyServing";
import { prepareTerminalEvidence, type PrefixReplay } from "./settlementEvidence";

export interface SettlementCoordinatorDeps {
  readonly store: FinancialGameStore;
  /** Is this game a money game? Production: `record.money !== null` (always false while money games are disabled). */
  readonly isFinancial?: (record: Readonly<GameRecord>) => boolean;
  readonly replay: PrefixReplay;
  readonly now: () => number;
  readonly warn: (line: string) => void;
  readonly ops?: OpsRecorder;
  /** LIVE-4 (L4-4): this pool's serving -- its capability (the escrow deployments it serves) and the chain's
   *  verification-grade facts -- shared with the escrow service when one is configured. Default: a pool that serves no
   *  escrow deployment (and speaks no financial protocol), on which every money game is `not-continued` and nothing is written
   *  (fail closed; never "continue everything"). */
  readonly serving?: MoneyServing;
  /** LIVE-4 (L4-4): the deal's identity of a game, read READ-ONLY from its durable log (`dealIdentity.ts`), where no
   *  announcement carried it (the liveness sweep, the startup walk). Throws only when the log cannot be read (then
   *  nothing is decided or written; retried). Absent: the deal is known only from announcements (undealt until then). */
  readonly readDeal?: (gameId: string) => Promise<GameIdentityFacts>;
  /** LIVE-4 (L4-4): the classes of a game's ticket ledger and chain intents beside its financial record (the escrow
   *  service's `artifactFormatsOf`: only for a financial protocol this pool speaks), so step -1 decides on exactly the
   *  facts the service decides on. Absent: not classified here (no escrow backend -- and then no deployment is served,
   *  so step -1 continues nothing anyway). */
  readonly artifactFormats?: (gameId: string, record: FinancialGameRecord) => Promise<ArtifactClasses>;
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
  /** LIVE-4 (L4-4): the deal's identity, read from the announced entries (step -1). */
  readonly identity: GameIdentityFacts;
  /** LIVE-4 (L4-4): the deployment the GameRecord's money terms name (who owns a game whose financial record is missing). */
  readonly termsKey: string | null;
  attempts: number;
}

/** LIVE-4 (L4-4): the deployment key a GameRecord's money terms name, or null (a no-money record, or no terms). */
const termsKeyOf = (record: Readonly<GameRecord>): string | null => moneyTermsKey((record as { money?: unknown }).money);

export interface StartupReconciliation {
  readonly financialGames: number;
  readonly loaded: number;
  readonly alreadyPrepared: number;
  readonly failed: ReadonlyArray<{ readonly gameId: string; readonly reason: string }>;
}

/* LIVE-4 (L4-2 + L4-4, integrated): THE COORDINATOR IS BOTH THE MONEY FACTS' INDEX AND THE VERDICT-BEFORE-WRITE SEAM.
   L4-2 made it the index the session verdict reads (`MoneyContinuationFacts`: `factsOf` / `refresh`); L4-4 made every
   write it does wait on the canonical verdict (step -1) and keeps the richer indexes that verdict reads (each financial
   record with its format class, and the ledger's and intents' classes). There is ONE index: `factsOf` is computed from
   L4-4's `financialIndex` / `formatIndex` -- an unreadable financial artifact is `unreadable` (with its class: a newer
   build's, an older one's, or damage), ESCROW-3A's held placeholder is `placeholder`, and a readable record is
   `{record, mci, deployment}` (with the ledger's and intents' classes where step -1 classified them) -- so the session
   and the money seams judge the same facts. `factsOf` and `refresh` write nothing; only step -1's owner writes. */
export interface SettlementCoordinator extends SettlementLifecycle, MoneyContinuationFacts {
  /** Run every queued job now; resolves when the queue is empty or every remaining job is waiting on a retry. */
  drain(): Promise<void>;
  /** Jobs queued or waiting to retry. */
  pending(): number;
  /** The stored continuation identity of a money game (loaded by `load`, kept current by every write). */
  continuationOf(gameId: string): MoneyContinuationIdentity | undefined;
  /** LIVE-4 (L4-4): this pool's serving (shared with the escrow service when one runs). */
  readonly serving: MoneyServing;
  /** LIVE-4 (L4-4), the money side of a serving decision, synchronously, for the room host's money-facts hook (L4-2):
   *  the canonical verdict for a game with a financial record, from the record as this coordinator last read it (its
   *  class included) and the deal's identity the caller holds -- the deployment half included. `undefined`: no financial
   *  record is known for the game here. */
  moneyServingOf(gameId: string, identity: GameIdentityFacts): MoneyServingDecision | undefined;
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
  const serving = deps.serving ?? noMoneyServing({ ops: deps.ops, warn: deps.warn, now: deps.now });
  /** LIVE-4 (L4-4): each financial record as last read here (or its class when it could not be), for the synchronous
   *  serving decision, and the deal's identity per game once dealt (a deal is immutable). */
  const financialIndex = new Map<string, { readonly fin: FormatFact; readonly record: FinancialGameRecord | null; readonly detail?: string }>();
  const identities = new Map<string, GameIdentityFacts>();
  /** LIVE-4 (L4-4): each game's ledger and intents classes as last classified here (for the synchronous decision). */
  const formatIndex = new Map<string, ArtifactClasses>();
  const schedule = deps.schedule ?? defaultSchedule;
  const retryBase = deps.retryMs ?? 5_000;
  const retryMax = deps.maxRetryMs ?? 5 * 60_000;
  const stats = { announced: 0, sealed: 0, prepared: 0, held: 0, repeats: 0, retries: 0, failures: 0 };
  /** Queued jobs by `${gameId}#${log_len}`: repeated announcements of one terminal history are ONE job. */
  const jobs = new Map<string, Job>();
  const continuations = new Map<string, MoneyContinuationIdentity>();
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

  /** The stored continuation identity -- none for a placeholder (unknown: nothing continues on its account). */
  const remember = (record: FinancialGameRecord) => {
    known.add(record.game_id);
    financialIndex.set(record.game_id, { fin: "current", record });
    if (record.continuation === null) continuations.delete(record.game_id);
    else continuations.set(record.game_id, record.continuation);
  };

  /* ------------------------------------------------------------------ */
  /* LIVE-4 (L4-4): step -1 -- the verdict before any write                */
  /* ------------------------------------------------------------------ */

  /** The deal's identity: the caller's (an announcement read it from its entries), else the durable log's (read until
   *  the deal is found), else undealt. */
  async function identityOf(gameId: string, given?: GameIdentityFacts): Promise<GameIdentityFacts> {
    const cached = identities.get(gameId);
    if (cached !== undefined) return cached;
    let identity: GameIdentityFacts = given ?? { kind: "undealt" };
    if (identity.kind === "undealt" && deps.readDeal !== undefined) identity = await deps.readDeal(gameId);
    if (identity.kind !== "undealt") identities.set(gameId, identity);
    return identity;
  }

  /** Reads the financial record (keeping its class when it cannot be read) and decides. Throws only on a store fault
   *  that is not a classification (the caller retries). */
  async function decide(gameId: string, identity: GameIdentityFacts, termsKey: string | null): Promise<{ readonly decision: MoneyServingDecision; readonly record: FinancialGameRecord | null; readonly fin: FormatFact | undefined }> {
    let record: FinancialGameRecord | null = null;
    let fin: FormatFact | undefined = "current";
    try {
      record = await deps.store.load(gameId);
    } catch (error) {
      if (!(error instanceof FinancialRecordUnreadableError)) throw error;
      fin = error.format;
      financialIndex.set(gameId, { fin: error.format, record: null, detail: error.message });
    }
    if (record !== null) remember(record);
    if (fin === "current" && record === null) fin = undefined;
    const facts: MoneyGameFacts = { fin, record, identity, ...(await artifactClassesOf(gameId, record)), ownerKey: termsKey };
    return { decision: serving.decide(facts), record, fin };
  }

  /** The ledger's and intents' classes beside a readable record of a financial protocol this pool speaks (`{}` else). */
  async function artifactClassesOf(gameId: string, record: FinancialGameRecord | null): Promise<ArtifactClasses> {
    if (record === null || deps.artifactFormats === undefined || !classifiesArtifacts(serving.capability, record)) return {};
    const classes = await deps.artifactFormats(gameId, record);
    formatIndex.set(gameId, classes);
    return classes;
  }

  /** The owner of a game whose financial record is MISSING writes ESCROW-3A's held placeholder -- once: one
   *  create-if-absent, already held, with no continuation identity (a racing creation converges on whichever landed). */
  async function writeMissingPlaceholder(gameId: string): Promise<"done" | "retry"> {
    const placeholder = missingRecordPlaceholder(gameId, deps.now(), "a money game had no financial record when the settlement seam looked for it");
    const outcome = await deps.store.create(placeholder);
    if (outcome.outcome.kind !== "committed") {
      deps.warn(`  settlement: ${gameId}'s missing-record placeholder was not written -- ${outcome.outcome.detail}; retrying`);
      return "retry";
    }
    if (outcome.existing === null) {
      remember(placeholder);
      continuations.delete(gameId);
      stats.held += 1;
      deps.ops?.audit("settlement.held", { game_id: gameId, code: "financial-record-missing" });
      deps.warn(`  settlement: ${gameId} is a money game with no financial record; a held placeholder was written -- restore the original record`);
    } else {
      remember(outcome.existing);
    }
    return "done";
  }

  /** A game step -1 did not continue: the OWNER of a conflict writes its canonical hold -- the missing record's
   *  placeholder once, or the hold on the record it can read (never a closed or cancelled one); anyone else, and every
   *  `not-continued`, writes nothing. */
  async function ownersConflict(gameId: string, decided: Awaited<ReturnType<typeof decide>>, at: number): Promise<"done" | "retry"> {
    const verdict = decided.decision.verdict;
    const code = decided.decision.holdCode;
    if (verdict.kind !== "conflict" || code === null) return "done";
    if (verdict.why === "financial-record-missing") return decided.fin === undefined ? writeMissingPlaceholder(gameId) : "done";
    if (decided.record === null || decided.record.phase === "closed" || decided.record.phase === "cancelled") return "done";
    const held = await apply(gameId, () => ({ kind: "hold", at, code, detail: `${verdict.why}: ${verdict.detail}` }));
    return held.ok ? "done" : "retry";
  }

  /** One transition, written by compare-and-swap; a stale view re-decides from the stored record (3 attempts). Only
   *  ever called AFTER step -1 decided this pool continues the game (L4-4): a record gone missing in between is not
   *  guessed at here (retried: step -1 then sees it missing, and only the owner writes the placeholder). */
  async function apply(gameId: string, event: (record: FinancialGameRecord) => FinancialEvent): Promise<{ ok: true; record: FinancialGameRecord; changed: boolean } | { ok: false; reason: string }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let record: FinancialGameRecord | null;
      try {
        record = await deps.store.load(gameId);
      } catch (error) {
        return { ok: false, reason: error instanceof FinancialRecordUnreadableError ? error.message : `the financial record could not be read (${String(error)})` };
      }
      if (record === null) return { ok: false, reason: "the financial record is missing (decided again at the next step -1)" };
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
    /* -1. LIVE-4 (L4-4): the verdict before any write. */
    let decided: Awaited<ReturnType<typeof decide>>;
    try {
      decided = await decide(job.gameId, await identityOf(job.gameId, job.identity), job.termsKey);
    } catch (error) {
      deps.warn(`  settlement: ${job.gameId}'s continuation could not be decided -- ${error instanceof Error ? error.message : String(error)}; retrying`);
      return "retry";
    }
    if (decided.decision.verdict.kind !== "continues") {
      serving.notice(job.gameId, decided.decision, "settlement");
      return ownersConflict(job.gameId, decided, at); // not this pool's: nothing written; the pool that continues it seals it
    }
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
    /* 2. (The continuation: decided at step -1, before anything was written.) 3. The evidence, from exactly the sealed prefix. */
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
      let identity: GameIdentityFacts;
      try {
        identity = gameIdentityOfEntries(input.entries);
      } catch {
        identity = { kind: "undealt" };
      }
      jobs.set(key, { gameId: input.gameId, seal: { log_len: input.seal.log_len, at: input.seal.at }, dealtAt: input.record.started_at, prefix, identity, termsKey: termsKeyOf(input.record), attempts: 0 });
      kick(0);
    },
    retentionOf(record): RetentionClass {
      return record.money === null && !isFinancial(record) ? { kind: "no-money" } : { kind: "financial", reason: FINANCIAL_RETENTION_REASON };
    },
    drain,
    pending: () => jobs.size,
    continuationOf: (gameId) => continuations.get(gameId),
    serving,
    /* LIVE-4 (L4-2), over L4-4's indexes: the money facts as the session's canonical verdict reads them. */
    factsOf(gameId): MoneyIndexEntry | undefined {
      const indexed = financialIndex.get(gameId);
      if (indexed === undefined) return undefined;
      if (indexed.record === null) return { kind: "unreadable", detail: indexed.detail ?? `the financial record is ${indexed.fin}`, format: indexed.fin };
      /* The same reading every money seam gives the record (`moneyFactsOf`): the placeholder is ESCROW-3A's held one. */
      const facts = moneyFactsOf({ fin: "current", record: indexed.record });
      if (facts !== null && facts.kind === "placeholder") return { kind: "placeholder" };
      const classes = formatIndex.get(gameId);
      return { kind: "record", mci: indexed.record.continuation, deployment: indexed.record.binding?.deployment ?? null, ...(classes?.tickets !== undefined ? { tickets: classes.tickets } : {}), ...(classes?.intents !== undefined ? { intents: classes.intents } : {}) };
    },
    /* LIVE-4 (L4-2): read one financial record again into the index (a money table's record is written by the escrow
       service before its GameRecord exists, and again before its deal). READ-ONLY: never a transition, hold or
       placeholder. A read that fails changes nothing already known (L4-2: identity and pin are write-once; step -1, which
       reads before it writes, is what records a known record's new class); a record never read is kept as a fact,
       not guessed at: unreadable, with its class when the store gave one (L4-4's), so no pool continues it (derived). */
    async refresh(gameId) {
      let record: FinancialGameRecord | null;
      try {
        record = await deps.store.load(gameId);
      } catch (error) {
        if (financialIndex.has(gameId)) return;
        if (error instanceof FinancialRecordUnreadableError) financialIndex.set(gameId, { fin: error.format, record: null, detail: error.message });
        else financialIndex.set(gameId, { fin: "corrupt", record: null, detail: `the financial record could not be read (${error instanceof Error ? error.message : String(error)})` });
        return;
      }
      if (record === null) return;
      remember(record);
      await artifactClassesOf(gameId, record).catch(() => undefined);
    },
    moneyServingOf(gameId, identity) {
      const indexed = financialIndex.get(gameId);
      if (indexed === undefined) return undefined;
      return serving.decide({ fin: indexed.fin, record: indexed.record, identity, ...(formatIndex.get(gameId) ?? {}) });
    },
    async load() {
      for (const gameId of await deps.store.list()) {
        known.add(gameId);
        try {
          const record = await deps.store.load(gameId);
          if (record !== null) remember(record);
        } catch (error) {
          if (error instanceof FinancialRecordUnreadableError) financialIndex.set(gameId, { fin: error.format, record: null, detail: error.message });
          /* LIVE-4 (L4-2): noted for the verdict too -- a record that could not be read at all is unreadable (never
             continued, derived), never read as missing. */ else financialIndex.set(gameId, { fin: "corrupt", record: null, detail: error instanceof Error ? error.message : String(error) });
          deps.warn(`  settlement: the financial record of ${gameId} cannot be read -- ${error instanceof Error ? error.message : String(error)}; it is not continued here`);
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
          if (error instanceof FinancialRecordUnreadableError) financialIndex.set(gameId, { fin: error.format, record: null, detail: error.message });
          failed.push({ gameId, reason: error instanceof Error ? error.message : String(error) });
          continue;
        }
        if (record !== null) {
          remember(record);
          /* L4-4: a game this pool does not continue is not loaded for settlement here (its own pool walks it). A
             conflict is loaded: its seal's job holds it (the owner) at step -1. */
          const decision = serving.decide({
            fin: "current",
            record,
            identity: await identityOf(gameId).catch((): GameIdentityFacts => ({ kind: "undealt" })),
            ...(await artifactClassesOf(gameId, record).catch((): ArtifactClasses => ({}))),
          });
          if (decision.verdict.kind === "not-continued") {
            serving.notice(gameId, decision, "startup walk");
            continue;
          }
        }
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
        /* L4-4: the verdict before any write -- a game this pool does not continue is not swept here (nothing written);
           the owner of a conflict writes its canonical hold (a missing record: its placeholder, once). */
        let decided: Awaited<ReturnType<typeof decide>>;
        try {
          decided = await decide(record.game_id, await identityOf(record.game_id), termsKeyOf(record));
        } catch {
          continue;
        }
        if (decided.decision.verdict.kind !== "continues") {
          serving.notice(record.game_id, decided.decision, "liveness sweep");
          await ownersConflict(record.game_id, decided, deps.now());
          continue;
        }
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
