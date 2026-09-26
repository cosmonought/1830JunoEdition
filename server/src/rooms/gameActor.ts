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
//   E-12 one actor per game (the registry)
//   E-13 the commit is the point of no return: committed -> MUST publish, rebuilding from the store if the next
//        view cannot be built; definite failure -> roll back; uncertain -> resolve before anything else runs
//
// WHAT 3A DOES NOT DO (LIVE-3B, immediately next): batch stamps, positional writes, short-write loops, torn-tail
// repair, fsync failure semantics, directory sync, the process lock and logDoctor. 3A makes a game's appends
// strictly one at a time -- which alone ends P2b's reordering -- and resolves a rejected append by reloading the
// room from the store (the LIVE-3A temporary rule, §21). It does not make the file itself crash-safe.

import type { RoomSession, ServerLogEntry } from "../../../frontend/src/utils/roomSession";
import { AHEAD_REASON, RESYNC_REASON } from "../../../frontend/src/utils/roomSession";
import type { SandboxRoomDoc } from "../../../frontend/src/utils/sandboxRoom";
import type { BuildId } from "../../../frontend/src/utils/serverProtocol";
import {
  buildCommittedView,
  catchUpFrom,
  entryAt,
  extendsHistory,
  withHold,
  withRoomDoc,
  type CommittedView,
  type Hold,
} from "./committedView";

/** E-7: tasks waiting behind the running one, per game. LIVE-2's per-game submit rate keeps this far away. */
export const ACTOR_QUEUE_BOUND = 256;
/** E-8: how long a queued task may wait before it is answered `retry` instead of run. */
export const TASK_DEADLINE_MS = 10_000;
/** §17 class 4: the backoff between attempts to read back a store whose outcome is not known. */
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

export type DocSettlement =
  | { readonly kind: "committed"; readonly view: CommittedView }
  /** The store did not take the document; the previous one stands. */
  | { readonly kind: "failed"; readonly reason: string };

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
  /** Durable-before-visible for the legacy room document (§21 LIVE-3A, F-10). Never throws. */
  commitRoomDoc(doc: SandboxRoomDoc, deliver: (settled: DocSettlement) => Delivery): Promise<DocSettlement>;
}

/** The store, as the actor sees it. Today's `LogStore` (fileLogStore.ts) sits behind it through `gameServer`; LIVE-3B
 *  replaces the durability mechanics beneath this seam without touching the executor. */
export interface GameStorePort {
  loadLog(gameId: string): Promise<readonly ServerLogEntry[]>;
  /** One submission's whole burst (L3-4). Resolves once it is on disk; rejects otherwise. */
  appendBatch(gameId: string, entries: readonly ServerLogEntry[]): Promise<void>;
  loadRoomDoc(gameId: string): Promise<SandboxRoomDoc | null>;
  saveRoomDoc(gameId: string, doc: SandboxRoomDoc): Promise<void>;
}

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
  };
}

/** Test-only fault seam. LIVE-3D generalises it into `FaultyGameStore` and named crash points (§20.1). */
export interface GameFaults {
  /** Called before every view build after the load; a throw here is a next view that could not be built (E-13). */
  beforeViewBuild?(gameId: string): void;
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
  /** The committed room document, through the server's single-flight document cache. */
  loadRoomDoc(): Promise<SandboxRoomDoc | null>;
  /** Called synchronously inside the publish that changed the committed room document. */
  onRoomDocPublished?(doc: Readonly<SandboxRoomDoc>): void;
  /** Called inside the publish that made entries durable and visible (`GameServerOptions.onAppend`). */
  onEntriesPublished?(entries: readonly ServerLogEntry[]): void;
  now(): number;
  warn(line: string): void;
  readonly counters: ActorCounters;
  readonly faults?: GameFaults;
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
const sameDocument = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class GameActor {
  readonly gameId: string;
  /** Resolves once the load -- the actor's first task (§3.6) -- has installed the first committed view. */
  readonly ready: Promise<void>;
  /** When this actor last did anything, for idle eviction. */
  lastActiveAt: number;

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
  private loaded = false;
  private disposed = false;

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
      this.queued.size === 0 &&
      this.running === null &&
      this.subscribers.size === 0 &&
      this.unresolved.size === 0 &&
      this.reconcileTimer === null &&
      this.committed?.hold?.reason !== "uncertain"
    );
  }

  /* ---------------------------------------------------------------------------
      THE LOAD: the actor's first task
     --------------------------------------------------------------------------- */

  private async load(): Promise<void> {
    /* RESTORED THROUGH `apply`, NEVER `submit` (#1203): a stored log already holds its derived entries. */
    const entries = await this.deps.store.loadLog(this.gameId);
    const roomDoc = await this.deps.loadRoomDoc();
    const session = this.deps.newSession();
    if (entries.length > 0) this.deps.restore(session, entries);
    this.session = session;
    this.committed = buildCommittedView({
      gameId: this.gameId,
      session,
      roomDoc,
      explainDivergence: this.deps.explainDivergence,
      version: 1,
    });
    this.loaded = true;
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
    options: { deadlineMs?: number; origin?: TaskOrigin } = {},
  ): Promise<RunResult<T>> {
    if (this.disposed) return Promise.resolve({ kind: "expired", reason: "closed" });
    /* A frame whose socket closed before its handler reached the queue is not queued at all: its socket's close
       has already cancelled everything that socket had queued, and this task must not outlive that (E-8). */
    if (options.origin !== undefined && !options.origin.isOpen()) {
      this.deps.counters.expiredSocketClosed += 1;
      return Promise.resolve({ kind: "expired", reason: "socket-closed" });
    }
    if (this.queued.size >= ACTOR_QUEUE_BOUND) {
      this.deps.counters.busy += 1;
      return Promise.resolve({ kind: "busy" });
    }
    return new Promise<RunResult<T>>((resolve) => {
      const task: Task<T> = {
        kind,
        op,
        origin: options.origin,
        deadlineAt: this.deps.now() + (options.deadlineMs ?? TASK_DEADLINE_MS),
        state: "queued",
        resolve,
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
    if (this.disposed) return this.expire(queued, "closed");
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
      this.lastActiveAt = this.deps.now();
      if (task.kind === "submit") this.finishSubmission(queued);
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
      commitRoomDoc: (doc, deliver) => this.commitRoomDoc(task, run, doc, deliver),
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
    let failure: unknown = null;
    try {
      await this.deps.store.appendBatch(this.gameId, batch);
    } catch (error) {
      failure = error ?? new Error("the store rejected the append");
    }

    if (failure === null) {
      /* COMMITTED. The task MUST publish. If the next view cannot be built from the session (the digest threw),
         the game is reloaded from the store -- whose history now holds the batch -- and published from that; the
         submitter is answered from the reloaded view. */
      let view: CommittedView;
      let entries: readonly ServerLogEntry[] = batch;
      try {
        view = this.buildNextView(this.session as RoomSession, before);
      } catch (error) {
        this.deps.counters.viewRebuiltFromStore += 1;
        this.deps.warn(
          `  commit: ${this.gameId} committed ${batch.length} entries but could not build the next view — ${describe(error)}; ` +
            `reloading the game from the store (E-13)`,
        );
        const adopted = await this.adoptStore(before);
        if (!adopted.ok) return this.settleUnresolved(task, adopted.detail, deliver);
        this.session = adopted.session;
        view = adopted.view;
        entries = adopted.landed;
      }
      const settled: BatchSettlement = { kind: "committed", view, entries };
      this.publish(view, task, deliver(settled), entries);
      return settled;
    }

    /* ==================================================================
        LIVE-3A: A REJECTED APPEND IS UNCERTAIN, AND THE STORE DECIDES (§21, the temporary rule until LIVE-3B)
       ==================================================================
       Today's store can reject after its bytes reached the file -- `write` then a failing `sync` -- so a rejection
       does not prove the entries absent, and answering "try again" for a move that landed invites a second
       purchase (LIVE-3 Appendix C.2 #7) or the F-13 shape one layer down: refused, and stored. So the room is
       reloaded from the store before anything else runs, and what the store holds is what stands:
         nothing past the committed history -> the move did not happen: rolled back, `retry`;
         some or all of the batch            -> those entries are durable: published, and the submitter is
                                                answered by whether its own entry is among them;
         the store cannot be read back       -> unknown: the game is held `uncertain` (E-10) and read back again
                                                on a backoff.
       LIVE-3B replaces this with positional redo writes and never trusts a read after an fsync error; until then a
       torn tail left by the failed write is today's loader's problem (F-8), which is why 3B follows at once. */
    this.deps.counters.storeAppendFailed += 1;
    this.deps.warn(
      `  store: could not append ${batch.length} entries for ${this.gameId} — ${describe(failure)}; ` +
        `reloading the game from the store before anything else runs (LIVE-3A)`,
    );
    const adopted = await this.adoptStore(before);
    if (!adopted.ok) return this.settleUnresolved(task, adopted.detail, deliver);
    this.session = adopted.session; // the clean rebuild E-4 asks for, from the store's own history
    if (adopted.landed.length === 0) {
      const settled: BatchSettlement = { kind: "absent", reason: describe(failure) };
      this.deliverOnly(task, deliver(settled));
      return settled;
    }
    this.deps.warn(
      `  store: ${this.gameId} holds ${adopted.landed.length} entries past index ${before.watermark} after the failed ` +
        `append; they stand (the log wins)`,
    );
    const settled: BatchSettlement = { kind: "committed", view: adopted.view, entries: adopted.landed };
    this.publish(adopted.view, task, deliver(settled), adopted.landed);
    return settled;
  }

  /** The room document, durable before it is visible (F-10: it used to change in memory first and be saved
   *  "quietly", so a failed save silently reverted the roster, a PIN or the host at the next restart). */
  private async commitRoomDoc(
    task: Task<unknown>,
    run: RunState,
    doc: SandboxRoomDoc,
    deliver: (settled: DocSettlement) => Delivery,
  ): Promise<DocSettlement> {
    if (run.commitIssued) throw new Error("E-6: a task commits at most once");
    run.commitIssued = true;
    let failure: unknown = null;
    try {
      await this.deps.store.saveRoomDoc(this.gameId, doc);
    } catch (error) {
      failure = error ?? new Error("the store rejected the room document");
    }
    if (failure !== null) {
      this.deps.counters.storeDocFailed += 1;
      /* WHICH DOCUMENT DOES THE STORE HOLD NOW? A save can report failure after its rename landed. The previous
         document stays authoritative unless the new one is what the store holds -- then it stands, and the writer
         is told it did. */
      let stored: SandboxRoomDoc | null | undefined;
      try {
        stored = await this.deps.store.loadRoomDoc(this.gameId);
      } catch {
        stored = undefined;
      }
      if (stored === undefined || stored === null || !sameDocument(stored, doc)) {
        this.deps.warn(
          `  store: could not save the room document for ${this.gameId} — ${describe(failure)}; the previous document stands`,
        );
        const settled: DocSettlement = { kind: "failed", reason: describe(failure) };
        this.deliverOnly(task, deliver(settled));
        return settled;
      }
      this.deps.warn(`  store: the room document for ${this.gameId} reported a failed save but the store holds it; it stands`);
    }
    const view = withRoomDoc(this.view, Object.freeze(doc));
    const settled: DocSettlement = { kind: "committed", view };
    this.publish(view, task, deliver(settled));
    return settled;
  }

  private buildNextView(session: RoomSession, before: CommittedView): CommittedView {
    this.deps.faults?.beforeViewBuild?.(this.gameId);
    return buildCommittedView({
      gameId: this.gameId,
      session,
      roomDoc: before.roomDoc,
      explainDivergence: this.deps.explainDivergence,
      version: before.version + 1,
    });
  }

  /** Reload the game from the store and build its view -- the log wins -- provided the store still begins with
   *  every entry this game acknowledged (W1). A store that does not is a history clients no longer share. */
  private async adoptStore(before: CommittedView): Promise<Adopted> {
    let entries: readonly ServerLogEntry[];
    try {
      entries = await this.deps.store.loadLog(this.gameId);
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
   *  whatever the store holds), the game takes no log write until the store is read back, and the submission is
   *  reported in `inFlight` until then. */
  private settleUnresolved(
    task: Task<unknown>,
    detail: string,
    deliver: (settled: BatchSettlement) => Delivery,
  ): BatchSettlement {
    this.deps.counters.unresolved += 1;
    this.rollbackSession();
    if (task.origin?.submissionId !== undefined) this.unresolved.set(task.origin.submissionId, task.origin.principal);
    const settled: BatchSettlement = { kind: "unresolved", reason: detail };
    const { reply } = deliver(settled);
    this.hold(detail, task, reply ?? null);
    return settled;
  }

  /** Enter (or stay in) the `uncertain` hold: publish it -- every subscriber is told -- and read the store back on
   *  a backoff. */
  private hold(detail: string, task: Task<unknown> | null = null, reply: object | null = null): void {
    this.deps.warn(
      `  store: ${this.gameId} is HELD (uncertain): ${detail}. Log writes are refused and reads are served from ` +
        `index ${this.committed?.watermark ?? -1} until the store can be read back (LIVE-3 §17 class 4).`,
    );
    if (this.committed !== null) {
      const hold: Hold = { reason: "uncertain", detail };
      this.publish(withHold(this.committed, hold), task, { reply });
    }
    this.scheduleReconcile();
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
    if (before.hold?.reason !== "uncertain") return;
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
    /* The submissions whose outcome was unknown are settled now: a landed one by the fan-out just sent, the rest
       by `abandoned` to their principal's sockets and to every socket that was told they were in flight. */
    this.unresolved.forEach((principal, submissionId) => {
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
    if (view.roomDoc !== null && view.roomDoc !== previous?.roomDoc) this.deps.onRoomDocPublished?.(view.roomDoc);
    const origin = task?.origin;
    if (delivery.reply && origin !== undefined) this.deliverTo(origin, delivery.reply); // 2. the answer
    if (delivery.fanout) {
      // 3. the fan-out, in commit order: every subscriber but the origin, queued now, written by `ws` later
      this.subscribers.forEach((subscriber, key) => {
        if (key !== origin?.key) this.deliverTo(subscriber, delivery.fanout as object);
      });
    }
    this.announceHold(previous?.hold ?? null, view.hold);
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
  return { kind: "status", state: "held", reason: hold.detail };
}
