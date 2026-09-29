// server/src/persistence/conformance/harness.ts
//
// ==================================================================
//  LIVE-5 L5-1: THE CONFORMANCE RUNNER -- ONE BEHAVIOURAL SUITE PER PORT, RUN AGAINST EVERY IMPLEMENTATION
// ==================================================================
//
// LIVE-3 §20.3 asked for a store conformance suite as the acceptance gate for DynamoDB (F-L5-1: nobody built it). This
// is the runner. A PORT (log, record, hold, financial, intent, ticket, identity, journal) has one module of cases; each
// case is written once, against the port's interface, and runs against every SUBJECT the test file supplies: today the
// in-memory and file implementations, and -- from L5-2 on -- the DynamoDB adapters.
//
// Stores differ, and the runner makes every difference EXPLICIT instead of letting a case quietly pass:
//
//   capabilities   what a subject can be asked at all. A case that needs a capability a subject lacks is SKIPPED with the
//                  reason printed -- never run half, never passed. Declaring a capability REQUIRES its hook (checked at
//                  registration): a subject cannot claim "inject-lost-answer" without `armLostAnswer`.
//   backend        what kind of store the subject is. A `dynamodb` subject MUST declare the capabilities LIVE-5's design
//                  depends on (the fence inside the write, lost-answer and transient-failure injection, the idempotency
//                  token, durability...), or name each omission in `exemptions` with a reason. A DynamoDB adapter cannot
//                  skip the fencing cases by leaving a word out.
//   differences    a reviewed, named semantic difference: `{ "TKT-09": "why" }`. The case is skipped for that subject with
//                  the sentence printed. Adding an entry is a reviewed decision, not a way to go green.
//
// Every case gets a fresh context: its own temporary directory (removed afterwards, and only it: the runner checks the
// prefix and the parent), its own fence and fault script, and a manual clock. After the case, the runner fails it if a
// scripted fault never fired.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { ControlledFence, FaultScript, type Gate } from "./faults";

export type Capability =
  /** A reopen (a new instance over the same backing) sees every committed write: a restart loses nothing. */
  | "durable"
  /** A writer can be made stale (`ctx.fence.takeOver()`), and the store then refuses its writes. */
  | "fence"
  /** The fence is checked INSIDE the write (a DynamoDB condition), so a takeover between a writer's own checks and its
   *  write still refuses it. The file stores check before writing (F-L5-4): they declare `fence` only, and the gap is
   *  pinned per port by `fenceGap.test.ts`. */
  | "fence-in-write"
  /** The test can place values the store did not write (damage, another build's format): hook `plant`. */
  | "plant"
  /** The store reaches storage through the `StoreFs` seam (file-only cases aim faults at its paths). */
  | "fs-faults"
  /** The next write can be held after the writer's own checks, just before it is applied: hook `stallNextWrite`. */
  | "stall-write"
  /** Operations on one key run in call order even when one of them stalls (the file stores' per-key chain). */
  | "ordered-under-stall"
  /** The store refuses to write a value that breaks the port's shape or invariants. */
  | "validates-shape"
  /** The log store recovers a torn final batch (a file concern: a transaction cannot tear). */
  | "torn-tail"
  /** A resend of an unknown outcome carries the SAME client request token (DynamoDB `ClientRequestToken`): hook
   *  `writeTokens`. */
  | "idempotency-token"
  /** The next write lands, and its answer is lost: hook `armLostAnswer`. */
  | "inject-lost-answer"
  /** The next write fails before it has any effect: hook `armTransientFailure`. */
  | "inject-transient-failure"
  /** The next write's outcome stays unknown however it is retried: hook `armUnresolvedWrite`. */
  | "inject-unresolved";

export type Backend = "memory" | "reference" | "file" | "dynamodb";

/** What a DynamoDB adapter must be able to show (the preflight's D-3/D-4 and FI cases). An omission needs an exemption. */
export const REQUIRED_CAPABILITIES: Readonly<Record<Backend, readonly Capability[]>> = Object.freeze({
  memory: [],
  reference: [],
  file: ["durable", "fence", "plant", "fs-faults", "stall-write", "inject-lost-answer", "inject-transient-failure"],
  dynamodb: ["durable", "fence", "fence-in-write", "plant", "stall-write", "idempotency-token", "inject-lost-answer", "inject-transient-failure"],
});

/** The hook a declared capability requires. */
const CAPABILITY_HOOKS: Partial<Record<Capability, string>> = {
  plant: "plant",
  "stall-write": "stallNextWrite",
  "idempotency-token": "writeTokens",
  "inject-lost-answer": "armLostAnswer",
  "inject-transient-failure": "armTransientFailure",
  "inject-unresolved": "armUnresolvedWrite",
};

export interface CaseContext {
  /** A fresh directory for this case alone. */
  readonly dir: string;
  readonly fence: ControlledFence;
  readonly faults: FaultScript;
  now(): number;
  /** Advance the manual clock (default 1 ms) and return the new time. */
  tick(ms?: number): number;
  /** Run after the case, before the directory is removed (close handles, drop tables). */
  defer(cleanup: () => void | Promise<void>): void;
}

export interface SubjectBase {
  /** e.g. "memory", "file", "dynamodb-local (proof)". */
  readonly name: string;
  readonly backend: Backend;
  readonly capabilities: readonly Capability[];
  /** Reviewed semantic differences: case id -> the reason this subject is intentionally different. */
  readonly differences?: Readonly<Record<string, string>>;
  /** Reviewed omissions of a capability its backend requires: capability -> the reason. */
  readonly exemptions?: Readonly<Partial<Record<Capability, string>>>;
}

export interface ConformanceCase<S extends SubjectBase> {
  readonly id: string;
  readonly title: string;
  readonly needs?: readonly Capability[];
  run(subject: S, ctx: CaseContext): Promise<void>;
}

export const T0 = 1_780_000_000_000;
const DIR_PREFIX = "gs-l5conf-";

export function skipReason<S extends SubjectBase>(subject: S, entry: ConformanceCase<S>): string | null {
  const difference = subject.differences?.[entry.id];
  if (difference !== undefined) return `intentional difference: ${difference}`;
  const missing = (entry.needs ?? []).filter((cap) => !subject.capabilities.includes(cap));
  return missing.length === 0 ? null : `${subject.name} does not declare ${missing.join(", ")}`;
}

/** Why this subject may not be registered (`null`: it may). */
export function subjectProblem<S extends SubjectBase>(subject: S, cases: readonly ConformanceCase<S>[]): string | null {
  const ids = new Set(cases.map((entry) => entry.id));
  for (const id of Object.keys(subject.differences ?? {})) if (!ids.has(id)) return `${subject.name} declares a difference for unknown case ${id}`;
  if (typeof (subject as unknown as { stored?: unknown }).stored !== "function") return `${subject.name} has no \`stored\` hook: every "nothing was written" check needs it`;
  for (const capability of subject.capabilities) {
    const hook = CAPABILITY_HOOKS[capability];
    if (hook !== undefined && typeof (subject as unknown as Record<string, unknown>)[hook] !== "function") return `${subject.name} declares ${capability} without its hook \`${hook}\``;
  }
  const missing = REQUIRED_CAPABILITIES[subject.backend].filter((cap) => !subject.capabilities.includes(cap) && subject.exemptions?.[cap] === undefined);
  if (missing.length > 0) return `${subject.name} is a ${subject.backend} store and must declare ${missing.join(", ")} (or name each omission in \`exemptions\`)`;
  for (const cap of Object.keys(subject.exemptions ?? {})) {
    if (subject.capabilities.includes(cap as Capability)) return `${subject.name} both declares and exempts ${cap}`;
  }
  return null;
}

/** Register one port's cases for every subject (node:test `describe` / `test`). */
export function runConformance<S extends SubjectBase>(port: string, subjects: readonly S[], cases: readonly ConformanceCase<S>[]): void {
  const ids = new Set<string>();
  for (const entry of cases) {
    if (ids.has(entry.id)) throw new Error(`conformance ${port}: case id ${entry.id} is used twice`);
    ids.add(entry.id);
  }
  for (const subject of subjects) {
    const problem = subjectProblem(subject, cases);
    if (problem !== null) throw new Error(`conformance ${port}: ${problem}`);
    describe(`${port} conformance — ${subject.name}`, () => {
      for (const entry of cases) {
        const reason = skipReason(subject, entry);
        test(`${entry.id} ${entry.title}`, reason === null ? {} : { skip: reason }, async () => {
          await runCase(subject, entry);
        });
      }
    });
  }
}

/** Run one case against one subject with a fresh context (exported for the runner's own tests and the F-L5-4 pins). */
export async function runCase<S extends SubjectBase>(subject: S, entry: ConformanceCase<S>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), DIR_PREFIX));
  const cleanups: Array<() => void | Promise<void>> = [];
  let clock = T0;
  const ctx: CaseContext = {
    dir,
    fence: new ControlledFence(),
    faults: new FaultScript(),
    now: () => clock,
    tick: (ms = 1) => (clock += ms),
    defer: (cleanup) => {
      cleanups.push(cleanup);
    },
  };
  let failure: unknown = null;
  try {
    await entry.run(subject, ctx);
    assert.deepEqual(ctx.faults.unfired(), [], `${entry.id}: every scripted fault must fire (a fault that never fires proves nothing)`);
  } catch (error) {
    failure = error;
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failure ??= error;
      }
    }
    removeCaseDirectory(dir);
  }
  if (failure !== null) throw failure;
}

/** Deterministic, and only ever a case's own directory: directly under the temp directory, with the runner's prefix. */
export function removeCaseDirectory(dir: string): boolean {
  if (!path.basename(dir).startsWith(DIR_PREFIX) || path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir())) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/* ------------------------------------------------------------------ */
/* Small shared helpers                                                 */
/* ------------------------------------------------------------------ */

/** Awaits a promise that must reject, returning the error. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

/** Wait until `pending` is stalled at `stall` -- failing at once, instead of hanging, if it settles without reaching it. */
export async function stalledAt(stall: Gate, pending: Promise<unknown>, what: string): Promise<void> {
  await Promise.race([
    stall.reached,
    pending.then(
      () => assert.fail(`${what} completed without reaching its stall`),
      (error: unknown) => assert.fail(`${what} failed without reaching its stall: ${String(error)}`),
    ),
  ]);
}

/** Let the event loop turn a few times (NOT a timer): enough for any work that is not blocked to make progress. */
export async function turns(count = 5): Promise<void> {
  for (let at = 0; at < count; at += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A hook the subject declared (the registration check guarantees it exists when its capability is declared). */
export function hook<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`the subject has no ${name} hook`);
  return value;
}
