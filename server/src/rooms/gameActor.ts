// server/src/rooms/gameActor.ts
//
// LIVE-3A: one game, one line of work at a time.
//
// ==================================================================
//  LIVE-3 L3-1 / L3-2: A PER-GAME ACTOR, AND NOTHING VISIBLE BEFORE IT IS DURABLE
// ==================================================================
//
// TODAY'S SUBMIT PATH WAS ALREADY "apply, append, answer, fan out" (#1250). What it lacked was EXCLUSION: while
// one move awaited the disk, a second submit, a `hello` or a room load could run against the same `RoomSession`
// -- reading an entry the store might never hold, building on it, and appending out of order. LIVE-1 found the
// shape; LIVE-3 reproduced it four ways (P1 non-durable reads and a store that lost a deal under a later move,
// P2 two sessions for one room, P2b file order following completion order, F-13 a thrown submit that was
// refused and committed anyway).
//
// SO EVERY MUTATION OF A GAME IS A TASK ON THAT GAME'S ACTOR, and the tasks run one at a time, in the order they
// were queued (E-1). A task reads the committed view and a PRIVATE session that equals it (E-2), speculates on
// the session, makes the result durable, and only then publishes: the new committed view replaces the old one
// synchronously, the submitter's answer and the fan-out are queued in the same step, and the next task starts
// from what was published (E-5). A reader -- a `hello`, a catch-up, a submit's host check -- never sees the
// session, only the view.
//
// A PROMISE CHAIN, NOT A MUTEX (§3.1). Node runs one thing at a time, so a chain is a total order for free, and
// the repository already trusts the shape (`inOrder`, #1216). The chain is wrapped in this class because a bare
// chain has nowhere to keep what the executor needs beside it: the view, the queue bound, deadlines, the running
// task, the subscribers and the holds.
//
// THE RULES, BY THE DESIGN'S NUMBERS (LIVE-3 §3.3), as they appear below:
//   E-1  one task at a time; E-2 read, check, mutate and commit inside one task
//   E-3  a task awaits only this game's store (the commit, and the reconcile re-read)
//   E-4  speculation is private; a failure before the commit rolls the session back to the view
//   E-5  publish is synchronous and last; nothing awaits a socket
//   E-6  at most one commit per task
//   E-7  a bounded queue (256) -- beyond it, `busy`
//   E-8  deadlines (10 s) and cancellation apply only to tasks that have not started; a closed socket's queued
//        tasks are cancelled at once and never run; a running task finishes whatever its socket does
//   E-9  a throw before the commit rolls back and commits nothing (F-13)
//   E-10 a game held for an unknown store outcome takes no log write; every hold and resume is announced
//   E-11 (LIVE-3B) every store call has a timeout (5 s); a WRITE that is late is uncertain, never failed: the game
//        is held and the task keeps waiting for that same call -- nothing rolls back, nothing runs behind it
//   E-12 one actor per game (the registry)
//   E-13 the commit is the point of no return: committed -> MUST publish, rebuilding from the store if the next
//        view cannot be built; definite failure -> roll back; uncertain -> resolve before anything else runs
//
// LIVE-3B: THE STORE NOW SAYS HOW A WRITE ENDED (persistence/storeResult.ts), so the 3A temporary rule -- "a
// rejected append: reload the room, and whatever the store shows wins" -- is gone. That re-read is exactly what
// LIVE-3 §8.2 step 7 forbids: after a failed `fsync` the page cache can show a batch the disk does not hold. Now:
//   committed  (possibly after the store REDID the batch at its offset) -> publish;
//   definite   (nothing reached storage) -> roll back, `retry`;
//   uncertain  (the store's redo failed too) -> held `uncertain` until the PROCESS RESTARTS; never read back.
// A load that finds a damaged log holds the game `corrupt`: no history served, nothing written, the file untouched
// until an operator repairs it (§8.5).

import type { RoomSession, ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { fenceScopeOf, isStoreCorrupt, isStoreIncompatible, outcomeOf, type FenceScope, type StoreWriteOutcome } from "../persistence/storeResult";
import { GameWithoutHeadError, type ClaimAnswer } from "./gameOwnership";
import { AHEAD_REASON, RESYNC_REASON } from "../../../frontend/src/utils/roomSession";
import type { GameRecord } from "./gameRecord";
import type { BuildId } from "../../../frontend/src/utils/serverProtocol";
import {
  buildCommittedView,
  catchUpFrom,
  entryAt,
  extendsHistory,
  isMaintenanceHold,
  withHold,
  withRecord,
  type CommittedView,
  type Hold,
} from "./committedView";
import { HELD_PLAYER_SENTENCE, type HoldCode } from "./lifecycle";

/** E-7: tasks waiting behind the running one, per game. LIVE-2's per-game submit rate keeps this far away. */
export const ACTOR_QUEUE_BOUND = 256;
/** E-8: how long a queued task may wait before it is answered `retry` instead of run. */
export const TASK_DEADLINE_MS = 10_000;
/** E-11: how long one store call may take before its outcome is treated as uncertain (LIVE-3 §3.3). */
export const STORE_TIMEOUT_MS = 5_000;
/** E-11: how long past that a late WRITE may stay unsettled before the process is asked to restart -- the only way
 *  left to learn what the disk holds (LIVE-3 §4.2: "about 60 s if uncertain"). */
export const STORE_RESTART_AFTER_MS = 60_000;
/** §8.5 / §17 class 5: what a room held `corrupt` -- LIVE-3C: or durably `held` -- says to everyone who asks. */
export const HELD_REASON = HELD_PLAYER_SENTENCE;
/** §17 class 4: the backoff between attempts to read back a store whose outcome is not known -- LIVE-3B: used only
 *  where a read-back is safe (the history is durable and only the view could not be built). */
export const RECONCILE_FIRST_MS = 1_000;
export const RECONCILE_MAX_MS = 30_000;

/** §17 class 4, the sentence a submitter and every subscriber get while the store's outcome is unknown. */
export const UNAVAILABLE_REASON =
  "The game server could not confirm the last move was recorded. It will appear when the game resumes if it was.";
/** §4.2: a submission whose socket went away was not recorded after all. */
export const ABANDONED_REASON =
  "That move was not recorded, so it was not made. The board is current -- make it again if you still want it.";

export type OpKind = "submit" | "room-op" | "repair";

/** Where a task came from. */
export interface TaskOrigin {
  /** The socket, by identity. Its close cancels the task if the task has not started (E-8). */
  readonly key: object;
  /** Who sent it -- the connection's actor, which before LIVE-2 is the legacy claimed id. */
  readonly principal: string;
  /** A submit's nonce: reported in a reconnecting hello's `inFlight` while the task runs (§3.5). */
  readonly submissionId?: string;
  isOpen(): boolean;
  send(frame: object): void;
}

/** A log socket subscribed to this game (a `hello`). */
export interface Subscriber {
  readonly principal: string;
  isOpen(): boolean;
  send(frame: object): void;
}

export type RunResult<T> =
  | { readonly kind: "ran"; readonly value: T }
  /** E-7: the queue was full; nothing was queued. */
  | { readonly kind: "busy" }
  /** E-8: never ran -- its deadline passed, its socket closed, or the server is closing. */
  | { readonly kind: "expired"; readonly reason: "deadline" | "socket-closed" | "closed" }
  /** The task threw. Before its commit that means rolled back and nothing durable (E-9). */
  | { readonly kind: "failed"; readonly error: unknown };

/** What a publish owes, queued in the same synchronous step that replaces the view (E-5). */
export interface Delivery {
  /** To the task's origin -- the submitter's answer. */
  readonly reply?: object | null;
  /** To every log subscriber but the origin, in commit order. */
  readonly fanout?: object | null;
  /** Anything else the publish owes, run synchronously after the view is replaced (room-document broadcasts). */
  readonly after?: () => void;
}

/** How a log commit settled (E-13). `committed` entries are durable AND published -- normally exactly the batch,
 *  or, when the store rejected the append and was read back, whatever it turned out to hold past the old
 *  watermark (the log wins). */
export type BatchSettlement =
  | { readonly kind: "committed"; readonly view: CommittedView; readonly entries: readonly ServerLogEntry[] }
  /** Definitely not durable: the store holds nothing past the committed history. Rolled back. */
  | { readonly kind: "absent"; readonly reason: string }
  /** Unknown: the game is held `uncertain` until the store can be read back. */
  | { readonly kind: "unresolved"; readonly reason: string };

/** LIVE-2C: a committed record is immutable all the way down -- its seats and admissions are shared by every reader. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** LIVE-2C: how a GameRecord commit settled (durable before visible). */
export type RecordSettlement =
  | { readonly kind: "committed"; readonly view: CommittedView }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "unresolved"; readonly reason: string };

/** What a task is handed. */
export interface Tx {
  /** The committed view this task starts from. The private session equals it (E-2). */
  readonly view: CommittedView;
  /** PRIVATE: advanced speculatively inside this task only; no reader ever sees it (E-4). Not to be used after
   *  `commitBatch` settles -- a reload may have replaced it. */
  readonly session: RoomSession;
  readonly origin: TaskOrigin | undefined;
  /** Answer the origin now, for a task that commits nothing. Synchronous; never awaits a socket (E-5). */
  reply(frame: object): void;
  /** Back to exactly the committed view (E-4). Only before a commit is issued. */
  rollback(): void;
  /** Make `batch` -- already speculated onto `session` -- durable, then publish (E-13). `deliver` is called
   *  synchronously with the outcome, in the step that publishes it. Never throws. */
  commitBatch(
    batch: readonly ServerLogEntry[],
    deliver: (settled: BatchSettlement) => Delivery,
  ): Promise<BatchSettlement>;
  /** LIVE-2C: durable-before-visible for the GameRecord, CONDITIONAL on the committed `record_version` (OCC): the
   *  record must be the committed one advanced by exactly one (or the first, version 1). Never throws. */
  commitRecord(record: GameRecord, deliver: (settled: RecordSettlement) => Delivery): Promise<RecordSettlement>;
}

/** The store, as the actor sees it. Today's `LogStore` (fileLogStore.ts) sits behind it through `gameServer`.
 *  LIVE-3B: writes answer with a classified outcome; a rejection is read as uncertain (`outcomeOf`). */
export interface GameStorePort {
  /** Rejects `StoreCorruptError` for a log held for an operator (the actor holds the game `corrupt`). */
  loadLog(gameId: string): Promise<readonly ServerLogEntry[]>;
  /** One submission's whole burst (L3-4): committed, definitely not written, or uncertain. */
  appendBatch(gameId: string, entries: readonly ServerLogEntry[]): Promise<StoreWriteOutcome>;
  /** LIVE-2C: the GameRecord (`null` for a game that does not exist). */
  loadRecord?(gameId: string): Promise<GameRecord | null>;
  /** LIVE-2C: conditional put -- `expected` is the committed version (`null`: must not exist). */
  saveRecord?(record: GameRecord, expected: number | null): Promise<StoreWriteOutcome>;
  /** LIVE-3C: the game's DURABLE hold, if it has one (`holdStore.ts`). An unreadable hold file answers
   *  `hold-unreadable` -- a hold is never lifted by being unreadable. */
  loadHold?(gameId: string): Promise<{ readonly code: HoldCode; readonly detail: string } | null>;
  /** LIVE-3C: write a durable hold down (create-if-absent). Resolves either way; the game is held in memory whatever
   *  the store answers, and a hold that did not reach the store is found again by the next load. */
  persistHold?(gameId: string, hold: { readonly code: HoldCode; readonly detail: string; readonly evidence: { record_version: number | null; record_status: string | null; log_entries: number | null } }): Promise<void>;
}

/** LIVE-3C: the load's verdict on a game whose record and log were both read (`reconcile.ts` `reconcileLoaded`). */
export type LoadVerdict = { readonly kind: "ok" } | { readonly kind: "hold"; readonly code: HoldCode; readonly detail: string };

/** Counted per server, read by tests and the smoke run. LIVE-3C turns these into §18's metrics. */
export interface ActorCounters {
  expiredDeadline: number;
  expiredSocketClosed: number;
  busy: number;
  storeAppendFailed: number;
  storeDocFailed: number;
  unresolved: number;
  reconciled: number;
  viewRebuiltFromStore: number;
  deliveryDropped: number;
  abandoned: number;
  helloResync: number;
  /** LIVE-3B: store calls past the E-11 timeout; late writes adopted once they committed. */
  storeTimeouts: number;
  lateAdopted: number;
  /** LIVE-3B: writes the store could not settle even by redoing them; games asking for a restart. */
  storeUncertain: number;
  restartRequired: number;
  /** LIVE-3B: games held `corrupt` at load. */
  heldCorrupt: number;
  /** LIVE-3C: games that loaded under a durable hold; holds this process found at a load and wrote down. */
  heldDurable: number;
  holdsFound: number;
}

export function newActorCounters(): ActorCounters {
  return {
    expiredDeadline: 0,
    expiredSocketClosed: 0,
    busy: 0,
    storeAppendFailed: 0,
    storeDocFailed: 0,
    unresolved: 0,
    reconciled: 0,
    viewRebuiltFromStore: 0,
    deliveryDropped: 0,
    abandoned: 0,
    helloResync: 0,
    storeTimeouts: 0,
    lateAdopted: 0,
    storeUncertain: 0,
    restartRequired: 0,
    heldCorrupt: 0,
    heldDurable: 0,
    holdsFound: 0,
  };
}

/** Test-only fault seam. LIVE-3D generalises it into `FaultyGameStore` and named crash points (§20.1). */
export interface GameFaults {
  /** Called before every view build after the load; a throw here is a next view that could not be built (E-13). */
  beforeViewBuild?(gameId: string): void;
  /** LIVE-3C, TEST ONLY: treat this game's board as ended (GameEnd). A stored game that genuinely reaches GameEnd
   *  needs a whole game played, so the terminal lifecycle -- the seal, the record's completion, the refusal of every
   *  later move, and their survival across a restart -- is driven through this seam; the reducer's own GameEnd
   *  refusals are the engine suites'. Never set by `start.ts`. */
  boardEnded?(gameId: string, session: RoomSession): boolean;
}

export interface GameActorDeps {
  readonly gameId: string;
  readonly build: BuildId;
  readonly explainDivergence: boolean;
  readonly store: GameStorePort;
  /** A session at the seed, nothing applied. */
  newSession(): RoomSession;
  /** Restores a session from a stored log (and says so in the window). */
  restore(session: RoomSession, entries: readonly ServerLogEntry[]): void;
  /** LIVE-2C: called synchronously inside the publish that changed the committed GameRecord. */
  onRecordPublished?(record: Readonly<GameRecord>): void;
  /** LIVE-4 (L4-2): called synchronously inside the publish that stopped serving the game -- the serving review's
   *  (`serving`), or a rebuild the actor did not publish that concluded "not continued / not served" (`rebuild`: a
   *  rollback after a refused deal, a failed task). The room host re-classifies it, re-broadcasts its view and frees its
   *  caps. Derived: nothing is written. */
  onNotServed?(gameId: string, source: "serving" | "rebuild"): void;
  /** Called inside the publish that made entries durable and visible (`GameServerOptions.onAppend`). */
  onEntriesPublished?(entries: readonly ServerLogEntry[]): void;
  now(): number;
  warn(line: string): void;
  readonly counters: ActorCounters;
  readonly faults?: GameFaults;
  /** E-11: the store-call timeout. `STORE_TIMEOUT_MS` when absent; tests shorten it. */
  readonly storeTimeoutMs?: number;
  /** E-11: how long a late write may stay unsettled before a restart is asked for. */
  readonly storeRestartAfterMs?: number;
  /** LIVE-3B: this game holds an outcome only a process restart can resolve (§8.2 step 7). */
  onRestartRequired?(gameId: string, detail: string): void;
  /** LIVE-5 L5-3 (POOL ownership, `gameOwnership.ts`): claim the game for this task -- the load's FIRST step, before
   *  anything of the game is read. A rejection fails the load (routed elsewhere, this task stale, or the outcome
   *  unknown). Absent (process ownership): nothing to claim. */
  claim?(): Promise<ClaimAnswer>;
  /** LIVE-5 L5-3: a commit was refused by an ownership FENCE (`fenceScopeOf`): another writer owns the game now. Called
   *  once, after the task's own definite answer; from then on this actor runs nothing more, and its owner drops it. */
  onFenced?(gameId: string, scope: FenceScope, detail: string): void;
  /** LIVE-3C: reconcile the record against the whole durable log and the replayed session, at the load. A `hold`
   *  verdict is written down (`persistHold`) and installed; no history is then served. Pure; must not throw. */
  reconcileAtLoad?(input: { readonly record: Readonly<GameRecord>; readonly entries: readonly ServerLogEntry[]; readonly session: RoomSession }): LoadVerdict;
  /** LIVE-3C (review): entries whose outcome was unknown were found in the store and ADOPTED (a late commit, a read-
   *  back after an uncertain write). The record's log-implied fields may lag them (a deal, GameEnd, CloseRoom that
   *  no record sync followed), so the host treats the game as unreconciled until its record has caught up. */
  onStoreAdopted?(): void;
}

/** How a `hello` was answered (§3.5). */
export type SubscribeAnswer =
  /** Registered, and the catch-up (with `inFlight`) already sent -- in one synchronous step. */
  | { readonly kind: "subscribed" }
  /** Not registered: the room is held for its rules version (#1520); the frame is the answer. */
  | { readonly kind: "held"; readonly frame: object }
  /** Not registered: this client's history is not the room's (L3-3). */
  | { readonly kind: "resync"; readonly watermark: number; readonly reason: string };

interface Task<T> {
  readonly kind: OpKind;
  readonly op: (tx: Tx) => Promise<T> | T;
  readonly origin: TaskOrigin | undefined;
  readonly deadlineAt: number;
  /** LIVE-4 (L4-2): a server housekeeping task that is not activity -- it must not keep an idle actor resident. */
  readonly quiet?: boolean;
  /** queued -> running | expired, exactly once (E-8: executed or answered as expired, never both). */
  state: "queued" | "running" | "expired" | "done";
  readonly resolve: (result: RunResult<T>) => void;
}

interface RunState {
  commitIssued: boolean;
}

type Adopted =
  | { readonly ok: true; readonly session: RoomSession; readonly view: CommittedView; readonly landed: readonly ServerLogEntry[] }
  | { readonly ok: false; readonly detail: string };

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class GameActor {
  readonly gameId: string;
  /** Resolves once the load -- the actor's first task (§3.6) -- has installed the first committed view. */
  readonly ready: Promise<void>;
  /** When this actor last did anything, for idle eviction. */
  lastActiveAt: number;
  /** LIVE-4 (L4-2): what the next publish that stops serving the game is attributed to (`onNotServed`): the serving
   *  review while it publishes, a rebuild otherwise. */
  private notServedSource: "serving" | "rebuild" = "rebuild";

  private readonly deps: GameActorDeps;
  private committed: CommittedView | null = null;
  private session: RoomSession | null = null;
  private chain: Promise<void>;
  private readonly queued = new Set<Task<unknown>>();
  private running: Task<unknown> | null = null;
  private readonly subscribers = new Map<object, Subscriber>();
  /** Submissions whose commit outcome is unknown (an `uncertain` hold), by nonce -> principal. Reported in
   *  `inFlight` until the store is read back, then settled by the fan-out (landed) or `abandoned` (not). */
  private readonly unresolved = new Map<string, string>();
  /** Submissions a hello reported in `inFlight`, by nonce -> the subscribers told. Each is settled for exactly
   *  them -- by the fan-out if it lands, by `abandoned` if it does not -- whatever became of its own socket. */
  private readonly reported = new Map<string, Set<object>>();
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileDelayMs = RECONCILE_FIRST_MS;
  /** Submissions a late write left in flight and settled when it ended: their task's own end must not settle
   *  them a second time. */
  private readonly settledLate = new Set<string>();
  private restartRequested = false;
  private loaded = false;
  private disposed = false;
  /** LIVE-5 L5-3: a commit was refused by an ownership fence: nothing more runs on this actor (`onFenced`). */
  private fencedOut = false;

  constructor(deps: GameActorDeps) {
    this.deps = deps;
    this.gameId = deps.gameId;
    this.lastActiveAt = deps.now();
    this.ready = this.load();
    // Every `run` queues behind the load; a failed load leaves nothing to run (the registry drops the actor).
    this.chain = this.ready.then(
      () => undefined,
      () => undefined,
    );
  }

  /** LIVE-2C: whether the load has published a committed view (before it, `view` throws). */
  get isLoaded(): boolean {
    return this.committed !== null;
  }

  /** LIVE-2C: holders that keep this actor resident though nobody reads its log -- the room view's subscribers
   *  (`roomHost.ts`). An actor with a pin is never idle, so it is never evicted under them. */
  private pins = 0;

  pin(): void {
    this.pins += 1;
  }

  unpin(): void {
    this.pins = Math.max(0, this.pins - 1);
  }

  /** The committed view. O(1); never waits on the queue. */
  get view(): CommittedView {
    if (this.committed === null) throw new Error(`game ${this.gameId} has not loaded`);
    return this.committed;
  }

  get queueDepth(): number {
    return this.queued.size;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** §3.6: nothing queued, nothing running, nobody subscribed, and no commit whose outcome is unknown (E-13). */
  get idle(): boolean {
    return (
      this.loaded &&
      !this.disposed &&
      !this.fencedOut &&
      this.queued.size === 0 &&
      this.running === null &&
      this.subscribers.size === 0 &&
      this.pins === 0 &&
      this.unresolved.size === 0 &&
      this.reconcileTimer === null &&
      this.committed?.hold?.reason !== "uncertain"
    );
  }

  /* ---------------------------------------------------------------------------
      THE LOAD: the actor's first task
     --------------------------------------------------------------------------- */

  /* LIVE-3C: THE LOAD IS WHERE A RESTARTED SERVER DECIDES WHAT A GAME IS, from its files alone, in this order:
       1. the log (validated; a torn final batch repaired -- LIVE-3B), the record, and any DURABLE HOLD;
       2. a durable hold wins: the game is served as held, nothing replayed, nothing written -- whatever the files
          look like now (a hold is lifted only by an operator's verified release, never by a load deciding afresh);
       3. a damaged log or an unreadable record is held, and the hold WRITTEN DOWN so the next start agrees;
       4. otherwise the log is replayed and reconciled against the record (`reconcile.ts`): a disagreement the log
          cannot settle is held and written down; a record that only lags its log is repaired by the room host
          afterwards, from the log (the log wins); an unsupported rules-engine pin is `incompatible` (#1520, derived).
     A held game keeps a session at the seed: its committed view serves no history, and no move can be built on it. */
  private async load(): Promise<void> {
    /* LIVE-5 L5-3 (POOL ownership): THE CLAIM COMES BEFORE ANY READ (preflight §5.3, LIVE-3 §14.2) -- so no write of an
       older owner can land after what this load reads: from the claim on, the table refuses them. Bounded like a read;
       a claim that fails or times out fails the load, and the next ask claims again (a claim is idempotent). */
    const claimed = this.deps.claim ? await this.awaitRead(this.deps.claim(), "claim of the game") : null;
    /* LIVE-3C (review E2): THE DURABLE HOLD IS READ FIRST. A held game's files are kept EXACTLY as found -- its log is
       not even opened here (the store's load repairs a torn tail, which is a write), and nothing is replayed. The
       offline tool verifies the files read-only before any release. */
    const durable = this.deps.store.loadHold ? await this.awaitRead(this.deps.store.loadHold(this.gameId), "load of the game's hold") : null;
    /* RESTORED THROUGH `apply`, NEVER `submit` (#1203): a stored log already holds its derived entries. */
    let entries: readonly ServerLogEntry[] = [];
    let corrupt: string | null = null;
    let newerLog: string | null = null;
    if (durable === null) {
      try {
        entries = await this.awaitRead(this.deps.store.loadLog(this.gameId), "load of the log");
      } catch (error) {
        /* LIVE-4 (integration, N-3): a log whose complete lines are a NEWER build's format is not damage and was not
           touched by the store: the game is not continued here (derived) -- the version hold a newer GameRecord gets,
           never written, never repaired. */
        if (isStoreIncompatible(error)) {
          newerLog = describe(error);
        } else {
          if (!isStoreCorrupt(error)) throw error;
          /* LIVE-3B (§8.5): HELD, NOT GUESSED AT. The file is untouched; no history is served and nothing is written
             until an operator repairs it offline (`tools/logDoctor.ts`) and releases it (`tools/gamesDoctor.ts`). */
          corrupt = describe(error);
        }
      }
    }
    /* LIVE-2C: the GameRecord, read in the same single-flight load. LIVE-3C: a record that cannot be read is held (a
       record written by a NEWER build is not damage: the game has no record this build can read, and is held as
       `version`, never written); neither is ever guessed at. */
    let record: GameRecord | null = null;
    let recordProblem: { readonly held: boolean; readonly detail: string } | null = null;
    if (this.deps.store.loadRecord) {
      try {
        record = await this.awaitRead(this.deps.store.loadRecord(this.gameId), "load of the game record");
      } catch (error) {
        if (isStoreCorrupt(error)) recordProblem = { held: true, detail: describe(error) };
        else if (isStoreIncompatible(error)) recordProblem = { held: false, detail: describe(error) };
        else throw error;
      }
    }
    /* LIVE-5 L5-3: the claim found NO HEAD, yet the game has data: it could never be written here (every write carries
       the HEAD fence), so it is not served as if it could -- refused, never guessed at (an importer writes the HEAD). */
    if (claimed?.kind === "absent" && (durable !== null || entries.length > 0 || corrupt !== null || newerLog !== null || record !== null || recordProblem !== null)) {
      throw new GameWithoutHeadError(this.gameId);
    }
    const evidence = { record_version: record?.record_version ?? null, record_status: record?.status ?? null, log_entries: corrupt === null ? entries.length : null };
    let session = this.deps.newSession();
    let hold: Hold | null = null;
    if (durable !== null) {
      hold = { reason: "held", code: durable.code, detail: durable.detail };
      this.deps.counters.heldDurable += 1;
      this.deps.warn(`  store: ${this.gameId} is HELD (${durable.code}): ${durable.detail}. Nothing is served or changed until an operator releases it.`);
    } else if (newerLog !== null) {
      /* LIVE-4 (integration, N-3): not continued here (`newer-format`), derived through the canonical model -- the
         session answers every hello and submit `incompatible` with that `why`; no hold is written, nothing is read into
         the engine, and the file is exactly as the store found it. */
      session.markLogNewerFormat(`the log holds records this build cannot read (a newer build's format): ${newerLog}`);
      this.deps.warn(`  store: ${this.gameId} is NOT CONTINUED here (newer-format): ${newerLog}; its log is left exactly as found`);
    } else if (corrupt !== null) {
      hold = { reason: "corrupt", code: "log-corrupt", detail: corrupt };
      this.deps.counters.heldCorrupt += 1;
      this.deps.warn(`  store: ${this.gameId} is HELD (corrupt): ${corrupt}. No history is served until an operator repairs it.`);
      await this.writeHold("log-corrupt", corrupt, evidence);
    } else if (recordProblem !== null) {
      if (recordProblem.held) {
        hold = { reason: "held", code: "record-unreadable", detail: recordProblem.detail };
        this.deps.warn(`  store: ${this.gameId} is HELD (record-unreadable): ${recordProblem.detail}`);
        await this.writeHold("record-unreadable", recordProblem.detail, evidence);
      } else {
        /* The detail of a version hold is a player-facing sentence (`statusFrame`); the operator's is in the window. */
        hold = { reason: "version", detail: "This game was saved by a newer game server than this one, which cannot read it. It is left untouched." };
        this.deps.warn(`  store: ${this.gameId} is INCOMPATIBLE: ${recordProblem.detail}; it is left untouched`);
      }
    } else {
      /* LIVE-3C (review E10): a log that frames correctly but does not REPLAY (a payload the engine cannot apply, a
         divergence) is deterministic damage, not a passing fault: held and written down -- never answered
         "unavailable" forever, never replayed again on every ask. */
      let replayFailed: string | null = null;
      if (entries.length > 0) {
        try {
          this.deps.restore(session, entries);
        } catch (error) {
          replayFailed = describe(error);
        }
      }
      const verdict: LoadVerdict | null =
        replayFailed !== null
          ? { kind: "hold", code: "replay-failed", detail: `the log's ${entries.length} entries do not replay: ${replayFailed}` }
          : record !== null && this.deps.reconcileAtLoad
            ? this.deps.reconcileAtLoad({ record, entries, session })
            : null;
      if (verdict !== null && verdict.kind === "hold") {
        hold = { reason: "held", code: verdict.code, detail: verdict.detail };
        this.deps.warn(`  store: ${this.gameId} is HELD (${verdict.code}): ${verdict.detail}. Its files are kept exactly as found.`);
        await this.writeHold(verdict.code, verdict.detail, evidence);
        session = this.deps.newSession(); // nothing replayed is kept: a held game serves no history
      }
    }
    this.session = session;
    this.committed = buildCommittedView({
      gameId: this.gameId,
      session,
      record,
      explainDivergence: this.deps.explainDivergence,
      version: 1,
      ...(hold === null ? {} : { hold }),
    });
    this.loaded = true;
  }

  /** LIVE-3C: a hold this load found, written down (create-if-absent). Bounded by the store timeout: the game is held
   *  in memory either way, and a hold that did not reach the store is simply found again by the next load. */
  private async writeHold(code: HoldCode, detail: string, evidence: { record_version: number | null; record_status: string | null; log_entries: number | null }): Promise<void> {
    this.deps.counters.holdsFound += 1;
    const persist = this.deps.store.persistHold;
    if (persist === undefined) return;
    try {
      await this.awaitRead(persist(this.gameId, { code, detail, evidence }), "write of the game's hold");
    } catch (error) {
      this.deps.warn(`  store: ${this.gameId}: its hold (${code}) could not be written down now -- ${describe(error)}; it is held in memory and the next load finds it again`);
    }
  }

  /** E-11 for a READ: past the timeout the caller is told it failed. The read itself is left to finish in the
   *  store's per-file order -- a read changes nothing the next call could build on (a load's torn-tail repair runs
   *  ahead of every later call on that file). */
  private async awaitRead<T>(pending: Promise<T>, label: string): Promise<T> {
    const limit = this.deps.storeTimeoutMs ?? STORE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.deps.counters.storeTimeouts += 1;
        reject(new Error(`the store did not answer the ${label} of ${this.gameId} within ${limit} ms`));
      }, limit);
    });
    try {
      return await Promise.race([pending, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------------------------------------------------------------------
      SUBSCRIPTION (§3.5): synchronous, so it can never fall between a publish and its fan-out
     --------------------------------------------------------------------------- */

  /** Register a log subscriber and send its catch-up from the committed view IN ONE SYNCHRONOUS STEP.
   *
   *  A publish is synchronous too (E-5), so a subscriber added before a publish receives that publish's fan-out
   *  and one added after sees it in this catch-up: never neither, never both. The catch-up carries `inFlight`, the
   *  nonces of this principal's submissions still being committed, so a reconnecting client does not call a move
   *  lost that is about to land (§4.2). */
  subscribe(key: object, subscriber: Subscriber, fromIndex: number, baseId?: string): SubscribeAnswer {
    const view = this.view;
    /* LIVE-5 L5-3: a RETIRED actor (dropped by its owner: fenced, or before its game is claimed back) serves nobody new --
       a hello that reached it in flight is sent to ask again, and meets the game's next actor. */
    if (this.fencedOut) return { kind: "resync", watermark: view.watermark, reason: RESYNC_REASON };
    if (isMaintenanceHold(view.hold)) return { kind: "held", frame: heldFrame() };
    if (view.incompatible !== null) return { kind: "held", frame: view.incompatible };
    if (fromIndex > view.watermark) {
      return { kind: "resync", watermark: view.watermark, reason: AHEAD_REASON };
    }
    if (baseId !== undefined && fromIndex >= 0 && entryAt(view, fromIndex)?.id !== baseId) {
      return { kind: "resync", watermark: view.watermark, reason: RESYNC_REASON };
    }
    this.subscribers.set(key, subscriber);
    this.lastActiveAt = this.deps.now();
    const inFlight = this.inFlightFor(key, subscriber.principal);
    this.deliverTo(subscriber, catchUpFrom(view, fromIndex, this.deps.build, { inFlight }));
    // A subscriber that arrives during a hold is told, since it will not see the transition that caused it.
    if (view.hold !== null) this.deliverTo(subscriber, statusFrame(view.hold));
    return { kind: "subscribed" };
  }

  unsubscribe(key: object): void {
    if (this.subscribers.delete(key)) this.lastActiveAt = this.deps.now();
    this.reported.forEach((told) => told.delete(key));
  }

  /** The nonces of this principal's submissions that may still commit: the running one, any still QUEUED from
   *  another socket, and any whose outcome is unknown (an `uncertain` hold).
   *
   *  QUEUED ONES TOO, which the design's "running" alone does not say. A closed socket's queued tasks are cancelled
   *  at its close (E-8) -- but the close arrives on the old connection and the reconnecting hello on a new one, and
   *  nothing orders the two: a half-open socket may not be seen to close for a minute. Until it is, its queued
   *  submission can still run and commit, and reporting it neither landed nor in flight would tell the player to
   *  make the move again. Every nonce reported here is remembered with the socket told, and settled for it. */
  private inFlightFor(key: object, principal: string): string[] {
    const ids: string[] = [];
    const add = (submissionId: string | undefined) => {
      if (submissionId !== undefined && !ids.includes(submissionId)) ids.push(submissionId);
    };
    const running = this.running?.origin;
    if (running !== undefined && running.principal === principal && running.key !== key) add(running.submissionId);
    this.queued.forEach((task) => {
      if (task.origin !== undefined && task.origin.principal === principal && task.origin.key !== key) {
        add(task.origin.submissionId);
      }
    });
    this.unresolved.forEach((owner, submissionId) => {
      if (owner === principal) add(submissionId);
    });
    for (const submissionId of ids) {
      const told = this.reported.get(submissionId) ?? new Set<object>();
      told.add(key);
      this.reported.set(submissionId, told);
    }
    return ids;
  }

  /* ---------------------------------------------------------------------------
      THE QUEUE (E-1, E-7, E-8)
     --------------------------------------------------------------------------- */

  /** Queue a task. It runs after every task queued before it has published or rolled back (E-1). */
  run<T>(
    kind: OpKind,
    op: (tx: Tx) => Promise<T> | T,
    options: { deadlineMs?: number; origin?: TaskOrigin; quiet?: boolean; essential?: boolean } = {},
  ): Promise<RunResult<T>> {
    if (this.disposed || this.fencedOut) return Promise.resolve({ kind: "expired", reason: "closed" });
    /* A frame whose socket closed before its handler reached the queue is not queued at all: its socket's close
       has already cancelled everything that socket had queued, and this task must not outlive that (E-8). */
    if (options.origin !== undefined && !options.origin.isOpen()) {
      this.deps.counters.expiredSocketClosed += 1;
      return Promise.resolve({ kind: "expired", reason: "socket-closed" });
    }
    /* LIVE-4 (L4-7): an ESSENTIAL task (the continuation review after a chain-facts change) is never refused for a full
       queue and never expires: it answers no client, and dropping it would leave the game playable after this process
       knows it must not be (the session's verdict is asked again only by it). */
    if (options.essential !== true && this.queued.size >= ACTOR_QUEUE_BOUND) {
      this.deps.counters.busy += 1;
      return Promise.resolve({ kind: "busy" });
    }
    return new Promise<RunResult<T>>((resolve) => {
      const task: Task<T> = {
        kind,
        op,
        origin: options.origin,
        deadlineAt: options.essential === true ? Number.POSITIVE_INFINITY : this.deps.now() + (options.deadlineMs ?? TASK_DEADLINE_MS),
        state: "queued",
        resolve,
        ...(options.quiet === true ? { quiet: true } : {}),
      };
      this.queued.add(task as Task<unknown>);
      /* The chain never rejects -- `execute` settles every task itself -- and the `catch` is the belt to that
         brace: one bad task must not poison every task behind it (#1216's lesson, one level down). */
      this.chain = this.chain.then(() => this.execute(task)).catch(() => undefined);
    });
  }

  /** E-8: a closed socket's QUEUED tasks are cancelled now, not when they reach the front -- none of them can run
   *  afterwards, and a hello that reported one in flight (it overtook this close) is told it was `abandoned`. A
   *  RUNNING task is untouched: the append is the commit point and the answer is news (#1209). */
  cancelQueuedFrom(key: object): number {
    let cancelled = 0;
    for (const task of this.queued) {
      if (task.origin?.key !== key) continue;
      this.queued.delete(task);
      this.expire(task, "socket-closed");
      cancelled += 1;
    }
    return cancelled;
  }

  private expire(task: Task<unknown>, reason: "deadline" | "socket-closed" | "closed"): void {
    task.state = "expired";
    if (reason === "deadline") this.deps.counters.expiredDeadline += 1;
    if (reason === "socket-closed") this.deps.counters.expiredSocketClosed += 1;
    task.resolve({ kind: "expired", reason });
    if (task.kind === "submit" && reason !== "closed") this.finishSubmission(task);
  }

  private async execute<T>(task: Task<T>): Promise<void> {
    const queued = task as Task<unknown>;
    if (task.state !== "queued") return; // cancelled while queued: it never runs (E-8)
    this.queued.delete(queued);
    if (this.disposed || this.fencedOut) return this.expire(queued, "closed");
    if (task.origin !== undefined && !task.origin.isOpen()) return this.expire(queued, "socket-closed");
    if (this.deps.now() > task.deadlineAt) return this.expire(queued, "deadline");

    task.state = "running";
    this.running = queued;
    const run: RunState = { commitIssued: false };
    try {
      const value = await task.op(this.txFor(queued, run));
      task.resolve({ kind: "ran", value });
    } catch (error) {
      /* E-9: A THROW BEFORE THE COMMIT ROLLS BACK AND COMMITS NOTHING. After the commit is issued, E-13 has
         already settled the task -- the commit helpers never throw -- so there is nothing to undo. */
      if (!run.commitIssued) this.rollbackSession();
      task.resolve({ kind: "failed", error });
    } finally {
      task.state = "done";
      this.running = null;
      if (task.quiet !== true) this.lastActiveAt = this.deps.now();
      if (task.kind === "submit") this.finishSubmission(queued);
      /* LIVE-4 (L4-2): a rebuild inside this task (a rollback after a refused deal, a failed task) may have concluded
         that this pool no longer continues -- or serves -- the game. The committed view is brought into line now. */
      this.publishIfNotServed("rebuild");
    }
  }

  private txFor(task: Task<unknown>, run: RunState): Tx {
    const session = this.session;
    if (session === null) throw new Error(`game ${this.gameId} has no session`);
    return {
      view: this.view,
      session,
      origin: task.origin,
      reply: (frame) => {
        if (task.origin !== undefined) this.deliverTo(task.origin, frame);
      },
      rollback: () => {
        if (run.commitIssued) throw new Error("E-13: a task cannot roll back once its commit was issued");
        this.rollbackSession();
      },
      commitBatch: (batch, deliver) => this.commitBatch(task, run, batch, deliver),
      commitRecord: (record, deliver) => this.commitRecord(task, run, record, deliver),
    };
  }

  /** E-4: the private session back to exactly the committed view. A full rebuild (`rollbackTo`), because a throw
   *  can leave the engine half-moved with the log untouched. */
  private rollbackSession(): void {
    const view = this.view;
    try {
      this.session?.rollbackTo(view.entries.length);
    } catch (error) {
      /* The committed history itself would not rebuild -- it did at the load and at every publish since, so this
         is a fault in the engine, not the log. A fresh session from the view, and if even that fails the game is
         held rather than advanced on a board nobody can vouch for. */
      this.deps.warn(`  actor: ${this.gameId} could not roll back — ${describe(error)}; rebuilding from the committed view`);
      try {
        const fresh = this.deps.newSession();
        if (view.entries.length > 0) this.deps.restore(fresh, view.entries);
        this.session = fresh;
      } catch (again) {
        this.hold(`the committed history could not be rebuilt: ${describe(again)}`);
      }
    }
  }

  /* ---------------------------------------------------------------------------
      THE COMMIT: the point of no return (E-13)
     --------------------------------------------------------------------------- */

  private async commitBatch(
    task: Task<unknown>,
    run: RunState,
    batch: readonly ServerLogEntry[],
    deliver: (settled: BatchSettlement) => Delivery,
  ): Promise<BatchSettlement> {
    if (run.commitIssued) throw new Error("E-6: a task commits at most once");
    run.commitIssued = true; // E-13: from here the task publishes, or settles as absent or unresolved
    const before = this.view;
    const priorHold = before.hold;
    const { outcome, late } = await this.awaitWrite(
      () => this.deps.store.appendBatch(this.gameId, batch),
      `append of ${batch.length} entries`,
      (detail) => {
        /* E-11: LATE IS UNCERTAIN, NOT FAILED. The game is held now and the submitter told `unavailable`; its
           submission is in flight (a reconnecting hello reports it) until this very call settles. Nothing is rolled
           back -- the batch may yet land -- and the task does not end, so nothing runs behind it. */
        const origin = task.origin;
        if (origin?.submissionId !== undefined) this.unresolved.set(origin.submissionId, origin.principal);
        const { reply } = deliver({ kind: "unresolved", reason: detail });
        this.publish(withHold(this.view, { reason: "uncertain", detail }), task, { reply: reply ?? null });
      },
    );

    if (outcome.kind === "committed") {
      /* COMMITTED (the store may have redone it -- the same bytes at the same offset, synced). The task MUST publish.
         If the next view cannot be built from the session (the digest threw), the game is reloaded from the store --
         whose history now holds the batch, durably, so reading it back is safe -- and published from that. */
      let view: CommittedView;
      let entries: readonly ServerLogEntry[] = batch;
      try {
        view = this.buildNextView(this.session as RoomSession, this.view);
      } catch (error) {
        this.deps.counters.viewRebuiltFromStore += 1;
        this.deps.warn(
          `  commit: ${this.gameId} committed ${batch.length} entries but could not build the next view — ${describe(error)}; ` +
            `reloading the game from the store (E-13)`,
        );
        const adopted = await this.adoptStore(before);
        if (!adopted.ok) return this.settleUnresolved(task, adopted.detail, late ? null : deliver, false);
        this.session = adopted.session;
        view = adopted.view;
        entries = adopted.landed;
      }
      const settled: BatchSettlement = { kind: "committed", view, entries };
      if (!late) {
        this.publish(view, task, deliver(settled), entries);
        return settled;
      }
      /* A LATE COMMIT IS ADOPTED EXACTLY ONCE: published as history to every subscriber -- the submitter included,
         who was told `unavailable` and kept the move pending -- and the hold lifts with it. */
      this.deps.counters.lateAdopted += 1;
      this.deps.warn(`  store: ${this.gameId}: the late append committed; published at index ${view.watermark}`);
      this.publish(view, null, { fanout: this.appliedFrame(entries, view) }, entries);
      this.settleUnresolvedSubmissions(true);
      this.deps.onStoreAdopted?.();
      return settled;
    }

    this.deps.counters.storeAppendFailed += 1;
    if (outcome.kind === "definite") {
      /* §4.1: NOTHING REACHED THE DISK. Rolled back -- the nonce with it, so a retry is judged afresh. */
      this.deps.warn(`  store: could not append ${batch.length} entries for ${this.gameId} — ${outcome.detail}; nothing was written`);
      this.rollbackSession();
      const settled: BatchSettlement = { kind: "absent", reason: outcome.detail };
      if (!late) {
        this.deliverOnly(task, deliver(settled));
        this.reportFenced(outcome);
        return settled;
      }
      this.publish(withHold(this.view, priorHold), null, {}); // the hold lifts; the in-flight move is abandoned
      this.settleUnresolvedSubmissions(true);
      this.reportFenced(outcome);
      return settled;
    }
    /* UNCERTAIN, AND THE STORE'S OWN REDO COULD NOT SETTLE IT (§8.2 step 7): held until the process restarts. Never
       read back -- a read after a failed `fsync` can show bytes the disk does not hold. */
    this.deps.counters.storeUncertain += 1;
    return this.settleUnresolved(task, outcome.detail, late ? null : deliver, true);
  }

  /** E-11: one store WRITE, awaited for at most the store timeout -- and never abandoned. On time: its outcome.
   *  Late: `onLate` holds the game NOW, and the SAME call is still awaited, so the task does not end: no later task
   *  of this game runs, nothing is rolled back, and nothing is written behind it until the call's own outcome is
   *  known. A call that never settles keeps the game held and, after `storeRestartAfterMs` more, asks for the
   *  process restart that is then the only way to learn what the disk holds. */
  private async awaitWrite(
    call: () => Promise<StoreWriteOutcome>,
    label: string,
    onLate: (detail: string) => void,
  ): Promise<{ readonly outcome: StoreWriteOutcome; readonly late: boolean }> {
    let settled: Promise<StoreWriteOutcome>;
    try {
      settled = call().then(
        (outcome) => outcome,
        (error) => outcomeOf(error),
      );
    } catch (error) {
      settled = Promise.resolve(outcomeOf(error));
    }
    const limit = this.deps.storeTimeoutMs ?? STORE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lateSignal = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), limit);
    });
    const first = await Promise.race([settled, lateSignal]);
    clearTimeout(timer);
    if (first !== null) return { outcome: first, late: false };

    const detail = `the store did not answer the ${label} within ${limit} ms`;
    this.deps.counters.storeTimeouts += 1;
    this.deps.warn(`  store: ${this.gameId}: ${detail}; held until that call settles (E-11)`);
    onLate(detail);
    const restartAfter = this.deps.storeRestartAfterMs ?? STORE_RESTART_AFTER_MS;
    const restartTimer = setTimeout(
      () => this.requireRestart(`the ${label} has still not settled ${limit + restartAfter} ms after it was issued`),
      restartAfter,
    );
    (restartTimer as { unref?: () => void }).unref?.();
    try {
      return { outcome: await settled, late: true };
    } finally {
      clearTimeout(restartTimer);
    }
  }

  /** LIVE-2C: the GameRecord, durable before visible, conditional on the committed version (OCC). A failure before
   *  the store's rename leaves the committed record standing; an unresolved one holds the game for a restart. */
  private async commitRecord(
    task: Task<unknown>,
    run: RunState,
    record: GameRecord,
    deliver: (settled: RecordSettlement) => Delivery,
  ): Promise<RecordSettlement> {
    if (run.commitIssued) throw new Error("E-6: a task commits at most once");
    run.commitIssued = true;
    const expected = this.view.record?.record_version ?? null;
    const save = this.deps.store.saveRecord;
    if (save === undefined) {
      const settled: RecordSettlement = { kind: "failed", reason: "this server has no record store" };
      this.deliverOnly(task, deliver(settled));
      return settled;
    }
    if (record.record_version !== (expected ?? 0) + 1) {
      const settled: RecordSettlement = { kind: "failed", reason: `record version ${record.record_version} does not follow ${expected ?? "none"}` };
      this.deliverOnly(task, deliver(settled));
      return settled;
    }
    const priorHold = this.view.hold;
    const { outcome, late } = await this.awaitWrite(
      () => save(record, expected),
      "game record save",
      (detail) => this.publish(withHold(this.view, { reason: "uncertain", detail }), null, {}),
    );
    if (outcome.kind === "committed") {
      const base = late ? withHold(this.view, priorHold) : this.view;
      const view = withRecord(base, deepFreeze(record));
      const settled: RecordSettlement = { kind: "committed", view };
      this.publish(view, task, deliver(settled));
      return settled;
    }
    this.deps.counters.storeDocFailed += 1;
    if (outcome.kind === "definite") {
      this.deps.warn(`  store: could not save the game record for ${this.gameId} — ${outcome.detail}; the previous record stands`);
      if (late) this.publish(withHold(this.view, priorHold), null, {});
      const settled: RecordSettlement = { kind: "failed", reason: outcome.detail };
      this.deliverOnly(task, deliver(settled));
      this.reportFenced(outcome);
      return settled;
    }
    this.deps.counters.storeUncertain += 1;
    const settled: RecordSettlement = { kind: "unresolved", reason: outcome.detail };
    this.deliverOnly(task, deliver(settled));
    this.hold(outcome.detail, null, null, true);
    return settled;
  }

  private buildNextView(session: RoomSession, before: CommittedView): CommittedView {
    this.deps.faults?.beforeViewBuild?.(this.gameId);
    return buildCommittedView({
      gameId: this.gameId,
      session,
      record: before.record,
      explainDivergence: this.deps.explainDivergence,
      version: before.version + 1,
    });
  }

  /** Reload the game from the store and build its view -- the log wins -- provided the store still begins with
   *  every entry this game acknowledged (W1). A store that does not is a history clients no longer share. */
  private async adoptStore(before: CommittedView): Promise<Adopted> {
    let entries: readonly ServerLogEntry[];
    try {
      entries = await this.awaitRead(this.deps.store.loadLog(this.gameId), "read-back of the log");
    } catch (error) {
      return { ok: false, detail: `the store could not be read back: ${describe(error)}` };
    }
    if (!extendsHistory(before.entries, entries)) {
      return {
        ok: false,
        detail: `the store no longer begins with the ${before.entries.length} entries this game acknowledged`,
      };
    }
    try {
      const session = this.deps.newSession();
      if (entries.length > 0) this.deps.restore(session, entries);
      const view = this.buildNextView(session, before);
      return { ok: true, session, view, landed: entries.slice(before.entries.length) };
    } catch (error) {
      return { ok: false, detail: `the game reloaded from the store could not be built: ${describe(error)}` };
    }
  }

  /** §17 class 4: the outcome is unknown. The private session goes back to the committed view (a safe subset of
   *  whatever the store holds), the game takes no log write, and the submission is reported in `inFlight` until the
   *  outcome is known. `restart`: only a process restart can learn it (a store write whose redo failed) -- nothing is
   *  read back; otherwise (the history is durable and only its view failed) the store is read back on a backoff.
   *  `deliver` is null when the submitter was already answered (a late write, E-11). */
  private settleUnresolved(
    task: Task<unknown>,
    detail: string,
    deliver: ((settled: BatchSettlement) => Delivery) | null,
    restart: boolean,
  ): BatchSettlement {
    this.deps.counters.unresolved += 1;
    this.rollbackSession();
    if (task.origin?.submissionId !== undefined) this.unresolved.set(task.origin.submissionId, task.origin.principal);
    const settled: BatchSettlement = { kind: "unresolved", reason: detail };
    const reply = deliver === null ? null : deliver(settled).reply ?? null;
    this.hold(detail, deliver === null ? null : task, reply, restart);
    return settled;
  }

  /** Enter (or stay in) the `uncertain` hold and publish it -- every subscriber is told. Then either read the store
   *  back on a backoff, or (`restart`) ask for the process restart that is the only safe way to learn the outcome. */
  private hold(detail: string, task: Task<unknown> | null = null, reply: object | null = null, restart = false): void {
    this.deps.warn(
      `  store: ${this.gameId} is HELD (uncertain): ${detail}. Log writes are refused and reads are served from ` +
        `index ${this.committed?.watermark ?? -1} ` +
        (restart ? "until the server is restarted (LIVE-3 §8.2 step 7)." : "until the store can be read back (LIVE-3 §17 class 4)."),
    );
    if (this.committed !== null) {
      const hold: Hold = restart ? { reason: "uncertain", detail, restart: true } : { reason: "uncertain", detail };
      this.publish(withHold(this.committed, hold), task, { reply });
    }
    if (restart) this.requireRestart(detail);
    else this.scheduleReconcile();
  }

  /** Once per game: say that only a restart can resolve what this game is holding, and tell the server. */
  private requireRestart(detail: string): void {
    if (this.restartRequested || this.disposed) return;
    this.restartRequested = true;
    this.deps.counters.restartRequired += 1;
    this.deps.warn(
      `  store: ${this.gameId} holds a store outcome only a restart can resolve — ${detail}. Log writes are refused; ` +
        `restart the server, and the load will read what the disk really holds (LIVE-3 §8.2 step 7).`,
    );
    try {
      this.deps.onRestartRequired?.(this.gameId, detail);
    } catch (error) {
      this.deps.warn(`  actor: the restart hook threw for ${this.gameId} — ${describe(error)}`);
    }
  }

  private scheduleReconcile(): void {
    if (this.reconcileTimer !== null || this.disposed) return;
    const delay = this.reconcileDelayMs;
    this.reconcileDelayMs = Math.min(RECONCILE_MAX_MS, delay * 2);
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.run("repair", () => this.reconcile());
    }, delay);
    (this.reconcileTimer as { unref?: () => void }).unref?.();
  }

  /** A `repair` task: read the store back; if it can be, what it holds stands, and the game resumes. */
  private async reconcile(): Promise<void> {
    const before = this.view;
    if (before.hold?.reason !== "uncertain" || before.hold.restart === true) return;
    const adopted = await this.adoptStore(before);
    if (!adopted.ok) {
      this.deps.warn(`  store: ${this.gameId} is still held — ${adopted.detail}; reading it back again later`);
      this.scheduleReconcile();
      return;
    }
    this.session = adopted.session;
    this.reconcileDelayMs = RECONCILE_FIRST_MS;
    this.deps.counters.reconciled += 1;
    const { view, landed } = adopted;
    this.deps.warn(
      `  store: ${this.gameId} resumed at index ${view.watermark} (${landed.length} entries found past ${before.watermark})`,
    );
    this.publish(view, null, landed.length > 0 ? { fanout: this.appliedFrame(landed, view) } : {}, landed);
    this.settleUnresolvedSubmissions(false);
    if (landed.length > 0) this.deps.onStoreAdopted?.();
  }

  /** The submissions whose outcome was unknown are settled now: a landed one by the fan-out just sent, the rest by
   *  `abandoned` to their principal's sockets and to every socket that was told they were in flight. `late`: their
   *  task is still running (E-11), so its own end must not settle them again. */
  private settleUnresolvedSubmissions(late: boolean): void {
    this.unresolved.forEach((principal, submissionId) => {
      if (late) this.settledLate.add(submissionId);
      const told = this.reported.get(submissionId);
      this.reported.delete(submissionId);
      if (this.landed(principal, submissionId)) return;
      const recipients = new Set<object>(told ?? []);
      this.subscribers.forEach((subscriber, key) => {
        if (subscriber.principal === principal) recipients.add(key);
      });
      this.sendAbandoned(recipients, submissionId);
    });
    this.unresolved.clear();
  }

  /** The fan-out frame for entries that just became durable, carrying the committed board's digest (#1223). */
  appliedFrame(entries: readonly ServerLogEntry[], view: CommittedView): object {
    return {
      kind: "applied",
      entries,
      digest: view.digest,
      ...(view.fields ? { fields: { ...view.fields } } : {}),
      build: this.deps.build,
    };
  }

  /* ---------------------------------------------------------------------------
      PUBLISH (E-5): the view, then the answer, then the fan-out -- one synchronous step
     --------------------------------------------------------------------------- */

  private publish(
    view: CommittedView,
    task: Task<unknown> | null,
    delivery: Delivery,
    entries?: readonly ServerLogEntry[],
  ): void {
    const previous = this.committed;
    this.committed = view; // 1. the committed view, replaced synchronously
    if (view.record !== null && view.record !== previous?.record) this.deps.onRecordPublished?.(view.record);
    const origin = task?.origin;
    if (delivery.reply && origin !== undefined) this.deliverTo(origin, delivery.reply); // 2. the answer
    if (delivery.fanout) {
      // 3. the fan-out, in commit order: every subscriber but the origin, queued now, written by `ws` later
      this.subscribers.forEach((subscriber, key) => {
        if (key !== origin?.key) this.deliverTo(subscriber, delivery.fanout as object);
      });
    }
    this.announceHold(previous?.hold ?? null, view.hold);
    /* LIVE-4 (L4-2): THE PUBLISH THAT STOPS SERVING THE GAME, whichever path made it -- the serving review, a rebuild
       the actor had not published (`publishIfNotServed`), or a store read-back that rebuilt a session which is no
       longer continued or served here. The room host re-classifies the game, re-broadcasts its view and frees its
       caps. (A load installs its first view without a publish; its conclusion is the room host's own.) */
    if (previous !== null && previous.incompatible === null && view.incompatible !== null) {
      try {
        this.deps.onNotServed?.(this.gameId, this.notServedSource);
      } catch (error) {
        this.deps.warn(`  actor: the not-served hook threw for ${this.gameId} — ${describe(error)}`);
      }
    }
    if (entries !== undefined && entries.length > 0) {
      try {
        this.deps.onEntriesPublished?.(entries);
      } catch (error) {
        this.deps.warn(`  actor: the append hook threw for ${this.gameId} — ${describe(error)}`);
      }
    }
    if (delivery.after) {
      try {
        delivery.after();
      } catch (error) {
        this.deps.warn(`  actor: a publish's broadcast threw for ${this.gameId} — ${describe(error)}`);
      }
    }
  }

  /** An outcome that published nothing still answers its origin inside the task. */
  private deliverOnly(task: Task<unknown>, delivery: Delivery): void {
    if (delivery.reply && task.origin !== undefined) this.deliverTo(task.origin, delivery.reply);
    if (delivery.after) {
      try {
        delivery.after();
      } catch (error) {
        this.deps.warn(`  actor: an answer threw for ${this.gameId} — ${describe(error)}`);
      }
    }
  }

  private announceHold(previous: Hold | null, next: Hold | null): void {
    if ((previous?.reason ?? null) === (next?.reason ?? null)) return;
    const frame = statusFrame(next);
    this.subscribers.forEach((subscriber) => this.deliverTo(subscriber, frame));
  }

  /** Queue one frame on one socket. A closed or throwing socket is counted and skipped: nothing rolls back for
   *  it, and it catches up when it reconnects (§4.2). */
  private deliverTo(target: { isOpen(): boolean; send(frame: object): void }, frame: object): void {
    if (!target.isOpen()) {
      this.deps.counters.deliveryDropped += 1;
      return;
    }
    try {
      target.send(frame);
    } catch {
      this.deps.counters.deliveryDropped += 1;
    }
  }

  /* ---------------------------------------------------------------------------
      ORPHANS (§4.2)
     --------------------------------------------------------------------------- */

  /** A submission that will not commit now -- it ran, or it was cancelled or expired before it could -- and did
   *  not land is `abandoned` to everyone left waiting on it: the sockets a hello told it was in flight, and, when
   *  its own socket is gone, its principal's current sockets (a client that reconnected keeps it pending). A
   *  landed one needs nothing: the fan-out or the catch-up carries its entry. An unresolved one waits for the
   *  store to be read back. */
  private finishSubmission(task: Task<unknown>): void {
    const origin = task.origin;
    const submissionId = origin?.submissionId;
    if (origin === undefined || submissionId === undefined) return;
    if (this.settledLate.delete(submissionId)) return; // settled when its late write ended (E-11)
    if (this.unresolved.has(submissionId)) return;
    const told = this.reported.get(submissionId);
    this.reported.delete(submissionId);
    const orphaned = !origin.isOpen();
    if (told === undefined && !orphaned) return; // its own socket got the answer, and nobody else was told
    if (this.landed(origin.principal, submissionId)) return;
    const recipients = new Set<object>(told ?? []);
    if (orphaned) {
      this.subscribers.forEach((subscriber, key) => {
        if (subscriber.principal === origin.principal) recipients.add(key);
      });
    }
    this.sendAbandoned(recipients, submissionId);
  }

  private landed(principal: string, submissionId: string): boolean {
    const entries = this.view.entries;
    for (let at = entries.length - 1; at >= 0; at -= 1) {
      if (entries[at].submission_id === submissionId && entries[at].actor === principal) return true;
    }
    return false;
  }

  private sendAbandoned(recipients: ReadonlySet<object>, submissionId: string): void {
    if (recipients.size === 0) return;
    this.deps.counters.abandoned += 1;
    const frame = { kind: "abandoned", inReplyTo: submissionId, reason: ABANDONED_REASON };
    recipients.forEach((key) => {
      const subscriber = this.subscribers.get(key);
      if (subscriber !== undefined) this.deliverTo(subscriber, frame);
    });
  }

  /**
   * LIVE-4 (L4-2): THE SERVING REVIEW -- the timer half of T-24, for a RESIDENT game. Queued as a task, so it never
   * interleaves a commit (E-1), and QUIET: it is housekeeping, not activity, so it never keeps an idle actor resident.
   * The session is asked whether its pool still serves the game (`RoomSession.reviewServing`: the pool's
   * `serveDecision` with the clock). If the answer is now "no" -- a draining pool's no-money drain passed its deadline,
   * the pool retired, the primary took the game -- the committed view is republished from the session
   * (`publishIfNotServed`). No reload of the actor, and nothing written. A game already held for any reason is left as
   * it is. Resolves true when the game stopped being served.
   */
  async reviewServing(options: { readonly continuation?: boolean } = {}): Promise<boolean> {
    const outcome = await this.run(
      "repair",
      async () => {
        const session = this.session;
        const before = this.committed;
        if (session === null || before === null || before.hold !== null || before.incompatible !== null) return false;
        /* LIVE-4 (integration): after a change in the chain facts, the verdict itself is asked again first. */
        if (options.continuation === true) session.reviewContinuation();
        else session.reviewServing();
        return this.publishIfNotServed("serving");
      },
      /* L4-7: the continuation review is essential -- never refused for a full queue, never expired behind a slow task
         (a dropped review would leave the game served after the contradiction). The timer's review is not: every submit
         asks the serving decision again with the clock. */
      { quiet: true, ...(options.continuation === true ? { essential: true } : {}) },
    );
    return outcome.kind === "ran" && outcome.value;
  }

  /**
   * LIVE-4 (L4-2): the committed view says the game is served while the private session says it is not -- the serving
   * review concluded "no", or a rebuild the actor did not publish (a rollback after a refused deal, a failed task)
   * asked the pool afresh and was told "no". Publish the session's held state -- the view a load of the game would
   * build now (a version hold carrying the player's sentence): every log subscriber is told, exactly as a version hold
   * is announced (`announceHold`: a `status` frame, `held`, with that sentence; its next hello or submit is answered
   * `incompatible`), and the room host re-classifies the game, re-broadcasts its view and frees its caps
   * (`onNotServed`). Nothing is written. A durable or store hold takes precedence and is left alone. True when a view
   * was published.
   */
  private publishIfNotServed(source: "serving" | "rebuild"): boolean {
    const session = this.session;
    const before = this.committed;
    if (this.disposed || session === null || before === null || before.hold !== null || before.incompatible !== null) return false;
    if (session.heldAnswer() === null) return false;
    this.notServedSource = source;
    try {
      this.publish(this.buildNextView(session, before), null, {}); // `publish` tells the room host (`onNotServed`)
    } finally {
      this.notServedSource = "rebuild";
    }
    return true;
  }

  /** LIVE-5 L5-3: whether this actor was retired -- a commit refused by an ownership fence, or dropped by its owner
   *  (`retire`): it runs nothing more. */
  get fenced(): boolean {
    return this.fencedOut;
  }

  /** LIVE-5 L5-3: nothing of this game is being written or may still land from this actor -- no task running, no store
   *  outcome unknown (an `uncertain` hold, a late write still being resent, an unresolved submission). Only then may its
   *  owner drop it and let the game be claimed again (`gameServer.ts` `retakeResident`): a write in flight from this
   *  actor must never find the game re-claimed under the same fence. */
  get quiescent(): boolean {
    return this.loaded && !this.disposed && this.running === null && this.unresolved.size === 0 && this.reconcileTimer === null && this.committed?.hold?.reason !== "uncertain";
  }

  /** LIVE-5 L5-3: run nothing more -- queued tasks are answered (never run), and every later `run` is refused. For the
   *  fenced reaction, and for an owner dropping a quiescent actor before its game is claimed again. Idempotent. */
  retire(): void {
    if (this.fencedOut) return;
    this.fencedOut = true;
    for (const task of this.queued) this.expire(task, "closed");
    this.queued.clear();
  }

  /**
   * LIVE-5 L5-3: THE FENCED REACTION (preflight §5.5, §5.8). A DEFINITE answer that is a fence refusal means the table
   * no longer names this task as the game's writer: whatever this actor holds is no longer the game's authority. The
   * task that met it has been answered as for any definite failure (nothing was written; rolled back); from here the
   * actor runs NOTHING more -- no retry, no queued task -- and its owner is told, once, so it drops the actor. The
   * next ask builds a fresh actor, whose load claims afresh (and is routed, or finds this task stale).
   */
  private reportFenced(outcome: StoreWriteOutcome): void {
    const scope = fenceScopeOf(outcome);
    /* Only under POOL ownership (the owner passes `onFenced`): a process-owned store never answers a fence text, and if
       one did, nothing here would change -- exactly as before L5-3. */
    if (scope === null || this.fencedOut || this.deps.onFenced === undefined) return;
    this.deps.warn(`  ownership: ${this.gameId}: a write was refused by the ${scope} fence -- another writer owns the game now; this actor runs nothing more`);
    this.retire();
    try {
      this.deps.onFenced(this.gameId, scope, outcome.kind === "definite" ? outcome.detail : "");
    } catch {
      /* the owner's hook reports its own failures */
    }
  }

  /** The server is closing, or the registry evicted this actor. Queued tasks are answered, never run. */
  dispose(): void {
    this.disposed = true;
    if (this.reconcileTimer !== null) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    for (const task of this.queued) this.expire(task, "closed");
    this.queued.clear();
    this.subscribers.clear();
    this.reported.clear();
  }
}

/** E-10: the frame every subscriber gets on a hold or a resume. */
export function statusFrame(hold: Hold | null): object {
  if (hold === null) return { kind: "status", state: "live" };
  if (hold.reason === "uncertain") return { kind: "status", state: "unavailable", reason: UNAVAILABLE_REASON };
  /* LIVE-3C: a maintenance hold says ONE fixed sentence to every player -- never the operator's detail, which may
     describe a record's contents. Only a version hold's detail is itself a player-facing sentence (#1520). */
  if (isMaintenanceHold(hold)) return { kind: "status", state: "held", reason: HELD_REASON };
  return { kind: "status", state: "held", reason: hold.detail };
}

/** §8.5 / §17 class 5: a hello to a room held `corrupt` -- no history is served, and nothing is registered. */
export function heldFrame(): object {
  return { kind: "error", code: "held", reason: HELD_REASON };
}
