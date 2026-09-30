// server/src/aws/ownership/poolWriter.ts
//
// ==================================================================
//  LIVE-5 L5-3: THE POOL WRITER -- ONE TASK'S HOLD ON ITS POOL, ITS ROLES AND ITS GENERATION
// ==================================================================
//
// Preflight D-4 / §5 / §13 step 4: there is no lease and no clock in any correctness decision. A task becomes its pool's
// writer by TAKING the pool (`POOL#<P>` `writer_epoch` + 1, L5-2's `takeOverPool`); from that write on, every write of
// every older task of the pool to a game this task claims is refused INSIDE the write by DynamoDB (the HEAD fence, L5-2).
// This object is the task's side of that: it holds the epoch it took, and it notices -- and says, once -- when it no
// longer holds what it needs, so the process stops serving from memory (L5-7 wires `onLost` to exit 3, as today's
// `EXIT_FENCED`).
//
// WHAT IS WATCHED (the SELF-CHECK, every `checkEveryMs` -- 2 s -- and on demand):
//   the pool       a strong read of `POOL#<P>`: `writer_epoch` and `writer_task` must still be this task's. Anything else
//                  -- a newer task, the item gone (a restored or replaced table) -- is LOST.
//   each role      (`holdRole`: the identity writer from `roles.ts`, the relayer from L5-6): its probe says held or lost.
//   the generation (`watchGeneration`: the ledger's adopted app generation, `roles.ts`): a restore was adopted -> LOST.
// A read that FAILS (a timeout, throttling, an item this build cannot parse) proves nothing either way: it is UNKNOWN, the
// task is not called lost, and it is not called current either -- the time of the last GOOD check stands still, so
// external side effects stop (`beforeSideEffect`) and readiness lapses (`readiness`) until a check succeeds again. Damage
// is never taken for a takeover, and a takeover is never taken for damage.
//
// LOST IS FINAL. `onLost(reason)` is called exactly once, synchronously, the first time anything proves the loss -- the
// self-check, a claim that found this task stale (`markLost`), or a store that refused a write for the POOL fence (the
// table itself evaluated `writer_epoch = :E` and it was false: epochs only move forward, so that is proof). After it,
// `assertCurrent` and `beforeSideEffect` refuse forever; the fence this task writes with is still refused by the table
// whatever this object believes -- the fences, not this object, are what keep a stale task from writing.
//
// THE SIDE-EFFECT GATE (`beforeSideEffect`, preflight §5.5): before an external side effect the table's fences cannot
// reach -- a KMS `Sign`, a broadcast, a join admission (L5-6 / L5-7 call it) -- the task must have passed a GOOD
// self-check within `freshForMs` (5 s); if the last one is older, a check is run NOW and must come back current. That
// catches a task resumed after a pause (LIVE-2F/3D C7's SIGSTOP class) before its first side effect. It does not make
// the stale window zero -- a pause right after a passing check can still let one side effect through -- which is why
// the ledger's own fences (the settlement reservation, the relayer fence inside the ledger, APPGEN) exist: nothing
// relies on this window, it only narrows it.
//
// WHAT IT IS NOT: a lease (nothing expires), a lock (two tasks may both believe they are current for a moment -- the
// table decides every write), or the startup sequence (L5-7 decides when to take the pool, when to take roles and when
// to serve; this object only offers the pieces).

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { fenceProblem, getItem, numberOf, poolKey, type WriterFence } from "../game/gameTable";
import { takeOverPool } from "../game/ownership";

/** A task's name in the pool and role items: 1-128 printable characters without spaces (the identity role's rule, so
 *  one task id serves both). */
const TASK_TEXT = /^[\x21-\x7e]{1,128}$/;

export const POOL_SELF_CHECK_MS = 2_000;
export const SIDE_EFFECT_FRESH_MS = 5_000;
export const READY_FOR_MS = 25_000;

/** What a held role (or the generation) answers when asked whether it is still this task's. Throw for "cannot tell". */
export type HeldAnswer = { readonly held: true } | { readonly held: false; readonly detail: string };
export interface HeldProbe {
  check(): Promise<HeldAnswer>;
}

export type SelfCheck =
  | { readonly kind: "current" }
  | { readonly kind: "lost"; readonly reason: string }
  /** Nothing was proven either way (a read failed): the last good check's time stands. */
  | { readonly kind: "unknown"; readonly detail: string };

export class PoolTakeoverLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoolTakeoverLostError";
  }
}

/** The task is not (or cannot now show it is) its pool's current writer: nothing may be done on its authority. */
export class PoolWriterNotCurrentError extends Error {
  constructor(
    message: string,
    readonly lost: boolean,
  ) {
    super(message);
    this.name = "PoolWriterNotCurrentError";
  }
}

export interface PoolWriterOptions {
  /** From `aws/awsClients.ts`, never made here. */
  readonly client: DynamoDBClient;
  /** The game table (where `POOL#` and `SYSTEM/ROUTING` live). */
  readonly table: string;
  readonly pool: string;
  /** This task's id (diagnostic in the pool and role items; the ECS task id, not an ARN). */
  readonly task: string;
  readonly now: () => number;
  /** Called ONCE when the loss is proven. L5-7: exit 3 (`EXIT_FENCED`). Must not throw (a throw is swallowed). */
  readonly onLost: (reason: string) => void;
  readonly checkEveryMs?: number;
  readonly freshForMs?: number;
  readonly readyForMs?: number;
  readonly warn?: (line: string) => void;
}

const describe = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export class PoolWriter {
  readonly pool: string;
  readonly task: string;
  readonly epoch: number;
  readonly client: DynamoDBClient;
  readonly table: string;

  private readonly options: PoolWriterOptions;
  private readonly roles = new Map<string, HeldProbe>();
  private generation: HeldProbe | null = null;
  private lostReason: string | null = null;
  /** When the last check that came back CURRENT was STARTED (what it proves is "current at some moment after this"). */
  private lastGoodAt: number;
  private inFlight: Promise<SelfCheck> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private constructor(options: PoolWriterOptions, epoch: number, takenFrom: number) {
    this.options = options;
    this.pool = options.pool;
    this.task = options.task;
    this.epoch = epoch;
    this.client = options.client;
    this.table = options.table;
    this.lastGoodAt = takenFrom;
  }

  /**
   * Take pool `options.pool` for `options.task` (preflight §13 step 4). From this write on, every older task of the pool
   * is fenced from every game this task claims. Rejects `PoolTakeoverLostError` when another task took the pool in
   * between (this task is already stale: it must not serve), and the store's error when the outcome is unknown.
   */
  static async take(options: PoolWriterOptions): Promise<PoolWriter> {
    const problem = fenceProblem({ pool: options.pool, epoch: 1 });
    if (problem !== null) throw new Error(`PoolWriter: ${problem}`);
    if (!TASK_TEXT.test(options.task)) throw new Error("PoolWriter: the task id must be 1-128 printable characters without spaces");
    for (const [name, value] of [["checkEveryMs", options.checkEveryMs], ["freshForMs", options.freshForMs], ["readyForMs", options.readyForMs]] as const) {
      if (value !== undefined && !(Number.isFinite(value) && value > 0)) throw new Error(`PoolWriter: ${name} must be a positive number of milliseconds`);
    }
    const started = options.now();
    const taken = await takeOverPool(options.client, options.table, options.pool, options.task, started);
    if (taken.kind === "lost") {
      throw new PoolTakeoverLostError(`pool ${options.pool} was taken by ${taken.by.writer_task ?? "another task"} at epoch ${taken.by.writer_epoch} while this task was taking it; this task is stale and serves nothing`);
    }
    return new PoolWriter(options, taken.epoch, started);
  }

  /** The fence every write of this task carries (and the task, for the claims' diagnostic `owner_task`). */
  get fence(): WriterFence & { readonly task: string } {
    return { pool: this.pool, epoch: this.epoch, task: this.task };
  }

  /** Why this task lost its hold (`null`: it has not, as far as anything has proven). */
  get lost(): string | null {
    return this.lostReason;
  }

  /** Throw unless nothing has proven this task stale (cheap, synchronous: for paths the fences already protect). */
  assertCurrent(): void {
    if (this.lostReason !== null) throw new PoolWriterNotCurrentError(`pool ${this.pool} epoch ${this.epoch} is no longer this task's: ${this.lostReason}`, true);
  }

  /** Watch a role this task took (the identity writer, the relayer): losing it is losing the task (preflight §5.5 --
   *  a demoted task must not keep serving from its in-memory authority; it restarts as whatever the routing says). */
  holdRole(name: string, probe: HeldProbe): void {
    this.assertCurrent();
    this.roles.set(name, probe);
  }

  /** Watch the adopted app generation (the ledger's APPGEN): a restore adopted elsewhere -> lost. */
  watchGeneration(probe: HeldProbe): void {
    this.assertCurrent();
    this.generation = probe;
  }

  /** The loss is proven by someone else (a claim found this task stale; a store refused a write for the POOL fence). */
  markLost(reason: string): void {
    if (this.lostReason !== null) return;
    this.lostReason = reason;
    this.stop();
    this.options.warn?.(`  pool: ${this.pool} epoch ${this.epoch} (${this.task}) is LOST -- ${reason}; this task serves nothing more on its authority`);
    try {
      this.options.onLost(reason);
    } catch {
      /* the owner's hook reports its own failures; the loss stands whatever it does */
    }
  }

  /** One self-check (single-flight: callers share one in progress). */
  check(): Promise<SelfCheck> {
    if (this.lostReason !== null) return Promise.resolve({ kind: "lost", reason: this.lostReason });
    this.inFlight ??= this.runCheck().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** A self-check soon, without waiting for it (a store reported a GAME fence: someone took a game; was it the pool?). */
  checkSoon(): void {
    void this.check().catch(() => undefined);
  }

  private async runCheck(): Promise<SelfCheck> {
    const started = this.options.now();
    const verdict = await this.evaluate();
    if (this.lostReason !== null) return { kind: "lost", reason: this.lostReason };
    if (verdict.kind === "lost") {
      this.markLost(verdict.reason);
      return verdict;
    }
    if (verdict.kind === "current") this.lastGoodAt = Math.max(this.lastGoodAt, started);
    else this.options.warn?.(`  pool: ${this.pool} epoch ${this.epoch}: the self-check could not tell (${verdict.detail}); side effects wait for a good check`);
    return verdict;
  }

  private async evaluate(): Promise<SelfCheck> {
    let item;
    try {
      item = await getItem(this.client, this.table, poolKey(this.pool));
    } catch (error) {
      return { kind: "unknown", detail: `the pool item could not be read (${describe(error)})` };
    }
    if (item === null) return { kind: "lost", reason: `the pool item POOL#${this.pool} is gone (the table was restored or replaced)` };
    const epoch = numberOf(item.writer_epoch);
    const task = item.writer_task?.S;
    if (epoch === null || !Number.isSafeInteger(epoch) || task === undefined) return { kind: "unknown", detail: `the pool item POOL#${this.pool} is not well-formed` };
    if (epoch !== this.epoch || task !== this.task) {
      return { kind: "lost", reason: `pool ${this.pool} is at epoch ${epoch} (${task}), not this task's ${this.epoch}` };
    }
    for (const [name, probe] of [...this.roles.entries(), ...(this.generation === null ? [] : [["generation", this.generation] as const])]) {
      let answer: HeldAnswer;
      try {
        answer = await probe.check();
      } catch (error) {
        return { kind: "unknown", detail: `${name} could not be read (${describe(error)})` };
      }
      if (!answer.held) return { kind: "lost", reason: name === "generation" ? `the adopted app generation moved: ${answer.detail}` : `the ${name} role is no longer this task's: ${answer.detail}` };
    }
    return { kind: "current" };
  }

  /**
   * Before an external side effect (a KMS Sign, a broadcast, a join admission): resolve only when this task passed a
   * GOOD self-check within `freshForMs` -- running one now when the last is older. Rejects `PoolWriterNotCurrentError`
   * otherwise (lost, or not shown current just now). Never a substitute for the fences in the write itself.
   */
  async beforeSideEffect(): Promise<void> {
    const freshFor = this.options.freshForMs ?? SIDE_EFFECT_FRESH_MS;
    /* A check already in flight may have STARTED before this call; what it proves may then be too old. So: at most two
       checks, the second one started after this call, and the answer is judged by the time the good check started. */
    for (let round = 0; ; round += 1) {
      this.assertCurrent();
      if (this.options.now() - this.lastGoodAt < freshFor) return;
      if (round === 2) throw new PoolWriterNotCurrentError(`pool ${this.pool} epoch ${this.epoch} could not be shown current within ${freshFor} ms; the side effect waits`, false);
      const verdict = await this.check();
      if (verdict.kind === "lost") throw new PoolWriterNotCurrentError(`pool ${this.pool} epoch ${this.epoch} is no longer this task's: ${verdict.reason}`, true);
      if (verdict.kind === "unknown") throw new PoolWriterNotCurrentError(`pool ${this.pool} epoch ${this.epoch} could not be shown current just now (${verdict.detail}); the side effect waits`, false);
    }
  }

  /** For `/gs/readyz` (L5-7): ready while not lost and a good check is younger than `readyForMs`. */
  readiness(): { readonly ready: boolean; readonly lost: string | null; readonly lastGoodAgeMs: number } {
    const age = this.options.now() - this.lastGoodAt;
    return { ready: this.lostReason === null && age < (this.options.readyForMs ?? READY_FOR_MS), lost: this.lostReason, lastGoodAgeMs: age };
  }

  /** Run the self-check every `checkEveryMs` until stopped or lost (the timer never keeps the process alive). */
  start(): void {
    if (this.timer !== null || this.lostReason !== null) return;
    this.timer = setInterval(() => this.checkSoon(), this.options.checkEveryMs ?? POOL_SELF_CHECK_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
