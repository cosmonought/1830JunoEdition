// server/src/aws/runtime/runtimeMetrics.ts
//
// ==================================================================
//  LIVE-6 L6-5A: THE AWS TASK'S METRICS -- CLOUDWATCH EMBEDDED METRIC FORMAT ON STDOUT, ONE STABLE SCHEMA
// ==================================================================
//
// An AWS task already writes its operator's audit lines to stdout (`consoleOps.ts`: `AUDIT {...}`, the file recorder's
// event names). This module adds the MEASUREMENTS L6-5B's alarms consume: one JSON object per line in CloudWatch's
// Embedded Metric Format (EMF). The awslogs driver ships each stdout line as one log event; CloudWatch Logs detects an
// EMF event by its `_aws` member and extracts the metrics itself (no header, no agent, no PutMetricData call, no IAM
// permission beyond the log group the task already writes). An `AUDIT ` line is never EMF (its prefix makes it not JSON),
// and an EMF line is never an audit line: the two streams never count the same thing twice.
//
// THE SCHEMA (`METRIC_SCHEMA` 1; namespace `METRIC_NAMESPACE`). Every metric this build may emit is in `METRICS`, with its
// KIND, its unit and its DIMENSION SCOPE; nothing else can be emitted (an unknown name is dropped, never invented). A
// record is `{ _aws: { Timestamp, CloudWatchMetrics: [directives] }, Environment, Pool, event, schema, <metrics>,
// <properties> }`, with its members in a fixed order (the catalog's for metrics, sorted for properties): the same inputs
// give the same bytes.
//
//   KIND   counter  the value is the number of occurrences THIS RECORD stands for (1 for one event; a delta for the KMS
//                   counters). Alarm on `Sum` over a period. Never a running total.
//          gauge    the value as of the record's timestamp (a 0/1 state, an age, a count seen at that moment). Alarm on
//                   `Minimum` / `Maximum` / `Average`; never `Sum`.
//   Everything else in a record -- the task id, the build, the generation, the pool epoch, reason codes, from/to states,
//   timestamps such as the last KMS failure -- is a PROPERTY: searchable in Logs Insights, never a metric dimension.
//
// DIMENSIONS (decided here, documented in the L6-5A report): only two, both low-cardinality and both from the runtime
// document -- `Environment` (the document's short label) and `Pool` (the pool id: one per deployment identity, so a few
// over the life of an environment). Scope `pool` emits under [Environment, Pool]; scope `environment` ALSO under
// [Environment] alone, for the forced-exit and failure counters whose alarms must survive a pool change (an incompatible
// deploy makes a new pool). NEVER a dimension: the task id (random per process -- a new series per restart), the build
// (every deploy), the generation (moves only at a restore, and an alarm must not break then), the epoch, a game, player,
// principal, session, profile, wallet, transaction, KMS key or ARN, a reason text or an error message.
//
// FAILURE IS SILENT AND HARMLESS. `emit` never throws and returns whether the line was written; nothing in the runtime
// waits for it or branches on it except the KMS delta bookkeeping (a delta is marked sent only when its line was written,
// so a failed line is carried to the next one -- never lost, never counted twice). A metric line never grants, withholds or
// delays anything: fencing, readiness, exit codes and the security journal are decided exactly as without it.

/** CloudWatch namespace of every metric this server emits (stable: L6-5B's alarms name it). */
export const METRIC_NAMESPACE = "18Cosmos/GameServer";
/** The record schema. A change of any name, kind, unit or scope below is a new schema number and an L6-5B change.
 *  LIVE-6 L6-5B ADDED metrics (the relayer's paging state, the generation / restore signals) and changed none: an
 *  addition is not a change of an existing series, so the schema stays 1. */
export const METRIC_SCHEMA = 1;

export type MetricKind = "counter" | "gauge";
export type MetricUnit = "Count" | "Seconds" | "None";
/** `pool`: [Environment, Pool]. `environment`: [Environment, Pool] AND [Environment]. */
export type MetricScope = "pool" | "environment";

export interface MetricSpec {
  readonly kind: MetricKind;
  readonly unit: MetricUnit;
  readonly scope: MetricScope;
}

const counter = (scope: MetricScope = "pool"): MetricSpec => Object.freeze({ kind: "counter", unit: "Count", scope });
const gauge = (unit: MetricUnit = "Count"): MetricSpec => Object.freeze({ kind: "gauge", unit, scope: "pool" });

/** Every metric of schema 1, in emission order. */
export const METRICS = Object.freeze({
  /* forced exits -- counted ONCE per task termination, at the one place the runtime decides it (`awsRuntime.ts`) */
  TaskLost: counter("environment"),
  /** The subset of `TaskLost` whose cause is `pool-superseded` (a PROVEN newer task of this pool took it: a rolling
   *  deploy, an ECS replacement -- `lossCauseOf`). `TaskLost - TaskSuperseded` is the loss to page on; `TaskSuperseded`
   *  itself, above the deploy count, is the preflight's "writer-epoch conflict" (two tasks of one pool taking it from each
   *  other). */
  TaskSuperseded: counter("environment"),
  StoreUncertain: counter("environment"),
  /** A startup that refused to go on (the task exits 2 and ECS starts another): one per refused start. Not counted when
   *  a loss or a store restart ended the startup (that exit is counted as such), nor for a stop asked for during it. */
  StartupRefused: counter("environment"),
  /* the money claim sweep -- one record per pass */
  MoneySweepPasses: counter(),
  MoneySweepPassFailed: counter("environment"),
  MoneySweepClaimed: counter(),
  MoneySweepGamesFailed: counter(),
  MoneySweepOwned: gauge(),
  MoneySweepElsewhere: gauge(),
  MoneySweepSkipped: gauge(),
  /* readiness -- transitions (events) and the state at each status tick (gauges) */
  ReadinessTransitions: counter(),
  BecameUnready: counter(),
  Ready: gauge("None"),
  Unready: gauge("None"),
  UnreadySeconds: gauge("Seconds"),
  Standby: gauge("None"),
  /** LIVE-6 L6-5B: 1 on the task holding the identity-writer role (from its takeover on); absent on every other task.
   *  The primary heartbeat (A13) counts its samples, so an alarm left on a demoted pool finds none and pages. */
  Primary: gauge("None"),
  PoolWriterConfirmed: gauge("None"),
  PoolWriterCheckAgeSeconds: gauge("Seconds"),
  /* the money claim sweep's health at each status tick */
  MoneySweepConsecutiveFailures: gauge(),
  MoneySweepSecondsSinceSuccess: gauge("Seconds"),
  /* the relayer role */
  RelayerTakeoverTaken: counter(),
  RelayerTakeoverNotTaken: counter("environment"),
  RelayerTakeoverNotPrimary: counter(),
  RelayerTransitions: counter(),
  RelayerHeld: gauge("None"),
  RelayerUsable: gauge("None"),
  RelayerOpenIntents: gauge(),
  EscrowActive: gauge("None"),
  /* KMS -- deltas of `kmsGate.ts`'s `KmsCounters` (the one source of truth), sent at each status tick */
  KmsSigns: counter("environment"),
  KmsSignWithheld: counter("environment"),
  KmsTransient: counter("environment"),
  KmsRefused: counter("environment"),
  KmsInvalidAnswer: counter("environment"),
  KmsOtherFailure: counter("environment"),
  /* the diagnostic TASK# item's own writes (never a correctness input) */
  TaskStatusWriteFailures: counter(),
  /* ---------------- LIVE-6 L6-5B: the converged runtime's remaining conditions ---------------- */
  /* L6-7's relayer paging state (`relayer.status()`), as gauges -- only from the relayer-role HOLDER whose relayer is
     usable (L6-7: only the holder pages; a task without the role keeps its conditions silently). Never a game, an intent
     or a condition code as a dimension: the condition codes stay in L6-7's `chain.relayer-page` audit lines. */
  /** `paging.paged`: conditions that have PAGED (L6-7's thresholds). >= 1 is a page, never suppressed by a flip window.
   *  Its alarm exists for EVERY pool (only the role holder emits it), so it follows the role, not the primary flag. */
  RelayerPaging: gauge(),
  /** `paging.waiting`: every waiting condition, paged or not yet. */
  RelayerWaiting: gauge(),
  /** `queue_mismatch`: RELAYQ# entries that disagree with their intent. */
  RelayerQueueMismatch: gauge(),
  /** `troubled`: intents backing off after an operational failure (F-L5-17). */
  RelayerTroubled: gauge(),
  /** Age of the oldest waiting condition (`paging.oldest_since`; 0 when none): no bookkeeping beyond L6-7's own. */
  RelayerOldestWaitingSeconds: gauge("Seconds"),
  /* L6-4 / L6-2: generation and restore. Counted at the one place the runtime decides each (never a REVIEW# scan). */
  /** The subset of `StartupRefused` refused by the GENERATION rules before the pool: APPGEN absent / unreadable / another
   *  number, the table's SYSTEM/GENERATION missing / damaged / another generation or table, or an adoption binding
   *  another table or restore (`refusal` generation | adoption). */
  StartupRefusedGeneration: counter("environment"),
  /** The subset of `StartupRefused` refused because the identity table's restore is incomplete (L6-4: not `complete`,
   *  a superseded source, an unreplayed copy -- the identity load's `IdentityRestoreIncompleteError`). */
  StartupRefusedIdentityRestore: counter("environment"),
  /** The subset of `TaskLost` whose cause is `generation-moved`: APPGEN moved under a serving task (its generation fence).
   *  A planned restore stops every task BEFORE the adoption (L6-6R's restore-quiet), so this is never an expected effect. */
  GenerationLost: counter("environment"),
  /** A money game HELD `journal-ahead` (the durable hold: the log does not reproduce what the ledger reserved, or the chain
   *  is ahead of it) -- after a restore, the F1 / quorum check's failure. From the escrow service's own `settlement.held`
   *  audit, as it is written (no second decision). */
  MoneyHeldJournalAhead: counter("environment"),
  /** 1 on the primary of a RESTORED game table (its SYSTEM/GENERATION origin `restore`: L6-2's post-restore safe mode,
   *  for the table's whole life -- a state, not an alarm). */
  RestoreSafeMode: gauge("None"),
  /** On a restored table: the money games whose restore check has run and is still PENDING (read-only, neither verified
   *  nor held). Only a primary has an escrow service; its alarm exists for every pool, like `RelayerPaging`. */
  RestoreUnverifiedGames: gauge(),
} satisfies Record<string, MetricSpec>);

export type MetricName = keyof typeof METRICS;
const METRIC_NAMES = Object.keys(METRICS) as MetricName[];

/** What a record is about (a property, never a dimension). */
export type MetricEvent =
  | "task-lost"
  | "store-uncertain"
  | "startup-refused"
  /** The counts not yet sent (KMS deltas, carried transitions) at the end of a graceful shutdown. */
  | "counters-flush"
  | "money-sweep"
  | "money-sweep-failed"
  | "readiness-transition"
  | "relayer-transition"
  | "relayer-takeover"
  /** L6-5B: a money game held `journal-ahead` (the escrow service's `settlement.held`). */
  | "money-held"
  | "task-status";

/** The only property names a record may carry (anything else is dropped). None of them may hold an identity, a game, a
 *  wallet, a key or a free error text: they are ids of THIS task and fixed codes. */
export const METRIC_PROPERTIES = Object.freeze([
  "task",
  "build",
  "generation",
  "epoch",
  "role",
  "phase",
  "ready",
  "reasons",
  "from",
  "to",
  "from_reasons",
  "to_reasons",
  "outcome",
  "when",
  "why",
  "cause",
  "stage",
  "store",
  "error_class",
  "relayer_state",
  "escrow_state",
  "kms_last_failure_at",
  "task_status",
  "uptime_seconds",
  /** L6-5B: why a start was refused, as a fixed code (generation | adoption | identity-restore | other), never the text. */
  "refusal",
] as const);
export type MetricProperty = (typeof METRIC_PROPERTIES)[number];
const PROPERTY_SET: ReadonlySet<string> = new Set(METRIC_PROPERTIES);

export type PropertyValue = string | number | boolean | null;

export interface MetricRecord {
  readonly event: MetricEvent;
  readonly metrics: Partial<Record<MetricName, number>>;
  readonly properties?: Partial<Record<MetricProperty, PropertyValue>>;
}

export interface MetricSink {
  /** Write one record. Never throws; true when the line was written. */
  emit(record: MetricRecord): boolean;
  /** Lines that could not be built or written (diagnostic). */
  failures(): number;
}

/** No metrics (PROCESS mode never loads this module; tests and callers that pass no sink get this). */
export const NO_METRICS: MetricSink = Object.freeze({ emit: () => false, failures: () => 0 });

/* ------------------------------------------------------------------ */
/* Values made safe                                                     */
/* ------------------------------------------------------------------ */

/** Shapes that must never leave the task in a metric line, whatever a caller passes: game ids, identity ids (principal,
 *  profile, session, family, recovery selector), ARNs, bech32 wallet/contract addresses, 64-hex digests, UUIDs (KMS key
 *  ids, request tokens). A property is a code or this task's own id; this is the second fence. */
const FORBIDDEN_SHAPES: readonly RegExp[] = [
  /\bg_[0-9a-z]{20,}\b/gi,
  /\b(?:pr|pf|se|sf|rk)_[0-9a-z_]{8,}\b/gi,
  /arn:[^\s"',]*/gi,
  /\b[a-z]{2,10}1[02-9ac-hj-np-z]{30,}\b/gi,
  /\b[0-9a-f]{64}\b/gi,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
];

const MAX_TEXT = 128;

/** An id this runtime was configured with or made itself -- the environment label, the pool id (a digest may be one,
 *  preflight §14.1), the build (an image digest may be one), this task's id: printable ASCII only (spaces become `_`), at
 *  most 128, and NOT shape-redacted (they are validated where they are read, and a digest-shaped pool must stay itself or
 *  every pool collapses into one dimension value). */
export function idText(value: string): string {
  const text = String(value).replace(/[^\x21-\x7e]/g, "_");
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}
/** The properties that are such ids (everything else is shape-redacted). */
const ID_PROPERTIES: ReadonlySet<string> = new Set(["task", "build"]);

/** A property or dimension string: printable ASCII only (spaces become `_`), forbidden shapes redacted, at most 128. */
export function safeText(value: string): string {
  let text = String(value);
  for (const shape of FORBIDDEN_SHAPES) text = text.replace(shape, "[redacted]");
  text = text.replace(/[^\x21-\x7e]/g, "_");
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

const CODE = /^[a-z][a-z0-9-]{0,39}$/;
/** A fixed code (a readiness reason, a state): a lower-case token, else `other` -- never free text. */
export const safeCode = (value: unknown): string => (typeof value === "string" && CODE.test(value) ? value : "other");
/** A set of codes, deduplicated and sorted, as one comma-separated property (`none` when empty). */
export const codeList = (values: readonly unknown[]): string => {
  const codes = [...new Set(values.map(safeCode))].sort();
  return codes.length === 0 ? "none" : codes.join(",");
};

/* ------------------------------------------------------------------ */
/* The EMF record                                                       */
/* ------------------------------------------------------------------ */

export interface EmfContext {
  /** The runtime document's `environment` label. */
  readonly environment: string;
  /** The runtime document's pool id. */
  readonly pool: string;
}

/**
 * The EMF JSON object of `record` (see the header). Deterministic: members in a fixed order. Invalid metric values
 * (unknown names, non-finite or negative numbers) are dropped; unknown property names are dropped; strings are made safe.
 * Returns null when nothing measurable is left.
 */
export function buildEmfRecord(context: EmfContext, at: number, record: MetricRecord): Record<string, unknown> | null {
  const values: Array<[MetricName, number]> = [];
  for (const name of METRIC_NAMES) {
    const value = record.metrics[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    values.push([name, value]);
  }
  if (values.length === 0) return null;
  const directive = (scope: MetricScope) => {
    const metrics = values.filter(([name]) => METRICS[name].scope === scope).map(([name]) => ({ Name: name, Unit: METRICS[name].unit }));
    if (metrics.length === 0) return null;
    return { Namespace: METRIC_NAMESPACE, Dimensions: scope === "environment" ? [["Environment", "Pool"], ["Environment"]] : [["Environment", "Pool"]], Metrics: metrics };
  };
  const directives = [directive("environment"), directive("pool")].filter((entry) => entry !== null);
  const out: Record<string, unknown> = {
    _aws: { Timestamp: Math.trunc(at), CloudWatchMetrics: directives },
    Environment: idText(context.environment),
    Pool: idText(context.pool),
    event: record.event,
    schema: METRIC_SCHEMA,
  };
  for (const [name, value] of values) out[name] = value;
  const properties = record.properties ?? {};
  for (const name of Object.keys(properties).sort()) {
    if (!PROPERTY_SET.has(name)) continue;
    const value = (properties as Record<string, unknown>)[name];
    if (value === null || typeof value === "boolean") out[name] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[name] = value;
    else if (typeof value === "string") out[name] = ID_PROPERTIES.has(name) ? idText(value) : safeText(value);
  }
  return out;
}

/** The sink an AWS task writes through: one EMF line per record (`write` is stdout in `awsMain.ts`). */
export function createEmfSink(options: { readonly context: EmfContext; readonly now: () => number; readonly write: (line: string) => void }): MetricSink {
  let failed = 0;
  return {
    emit(record) {
      try {
        const built = buildEmfRecord(options.context, options.now(), record);
        if (built === null) return false;
        options.write(JSON.stringify(built));
        return true;
      } catch {
        /* a metric line never stops, delays or changes the work it measures */
        failed += 1;
        return false;
      }
    },
    failures: () => failed,
  };
}

/* ------------------------------------------------------------------ */
/* Transitions: said when the state CHANGES, never per observation      */
/* ------------------------------------------------------------------ */

export interface TransitionTracker<S> {
  /** Look at the state now; a change from the last one observed is one transition (the first observation only sets the
   *  baseline). Returns true when this observation was a transition. */
  observe(state: S): boolean;
  /** Transitions that happened but are not in any line written yet (the per-minute cap, or a line that failed). */
  suppressed(): number;
  /** `n` of them were carried by a line that WAS written (the caller's status line): no longer pending. */
  settle(n: number): void;
  current(): S | null;
}

/** At most this many transition lines per minute per tracker; the rest are counted and carried by the next line
 *  (`represents`), so `Sum` stays exact while a flapping state cannot flood the log. */
export const TRANSITION_LINES_PER_MINUTE = 20;

export function transitionTracker<S>(options: {
  readonly key: (state: S) => string;
  readonly now: () => number;
  /** Write one transition; `represents` = 1 + the pending ones it carries. Return false when the line was NOT written
   *  (they all stay pending, to be carried by a later line); a throw counts as not written. */
  readonly onTransition: (from: S, to: S, represents: number) => boolean;
  /** A transition that was not written (capped, or its line failed): the caller may keep its own sub-counts. */
  readonly onPending?: (from: S, to: S) => void;
  readonly linesPerMinute?: number;
}): TransitionTracker<S> {
  const cap = options.linesPerMinute ?? TRANSITION_LINES_PER_MINUTE;
  let last: { state: S; key: string } | null = null;
  let windowStart = Number.NEGATIVE_INFINITY;
  let lines = 0;
  let suppressed = 0;
  return {
    observe(state) {
      let key: string;
      try {
        key = options.key(state);
      } catch {
        return false;
      }
      if (last === null) {
        last = { state, key };
        return false;
      }
      if (key === last.key) return false;
      const from = last.state;
      last = { state, key };
      const now = options.now();
      if (now - windowStart >= 60_000) {
        windowStart = now;
        lines = 0;
      }
      const pend = () => {
        suppressed += 1;
        try {
          options.onPending?.(from, state);
        } catch {
          /* never past here */
        }
      };
      if (lines >= cap) {
        pend();
        return true;
      }
      lines += 1;
      let written = false;
      try {
        written = options.onTransition(from, state, 1 + suppressed) === true;
      } catch {
        written = false;
      }
      if (written) suppressed = 0;
      else pend();
      return true;
    },
    suppressed: () => suppressed,
    settle(n) {
      if (Number.isSafeInteger(n) && n > 0) suppressed = Math.max(0, suppressed - n);
    },
    current: () => (last === null ? null : last.state),
  };
}

/* ------------------------------------------------------------------ */
/* Readiness                                                            */
/* ------------------------------------------------------------------ */

/** The readiness answer as metrics see it (the `/gs/readyz` answer's `ready` and `reasons`: opaque fixed codes, whatever
 *  the runtime -- today L5-7's, later L6-1's -- decides them to be). */
export interface ObservedReadiness {
  readonly ready: boolean;
  readonly reasons: readonly string[];
}

export interface ReadinessObserver {
  /** Observe an answer (from `/gs/readyz`, a status tick, a phase change): a transition is written once. */
  observe(answer: ObservedReadiness): void;
  /** The gauges at a status tick: `Ready`, `Unready` (not ready, and not an answer the runtime calls expected --
   *  `benign`), `UnreadySeconds` (how long it has been continuously `Unready`; 0 otherwise). */
  gauges(answer: ObservedReadiness): { readonly Ready: number; readonly Unready: number; readonly UnreadySeconds: number };
  /** The transitions not yet in a written line (and how many of them went from ready to not ready). */
  pending(): { readonly ReadinessTransitions: number; readonly BecameUnready: number };
  /** Those were carried by a line that was written. */
  settle(carried: { readonly ReadinessTransitions: number; readonly BecameUnready: number }): void;
}

/**
 * `benign(answer)`: an answer that is not ready BY DESIGN (L5-7: a standby's `not-primary` alone). It is still a
 * readiness transition when it changes, but never `Unready`. The runtime supplies it, so a later readiness model (L6-1's
 * standby semantics) changes the runtime's predicate, not this observer.
 */
export function readinessObserver(options: { readonly sink: MetricSink; readonly now: () => number; readonly benign: (answer: ObservedReadiness) => boolean; readonly properties: () => Partial<Record<MetricProperty, PropertyValue>>; readonly linesPerMinute?: number }): ReadinessObserver {
  let unreadySince: number | null = null;
  const unready = (answer: ObservedReadiness): boolean => {
    try {
      return !answer.ready && !options.benign(answer);
    } catch {
      return !answer.ready;
    }
  };
  const note = (answer: ObservedReadiness) => {
    if (unready(answer)) unreadySince ??= options.now();
    else unreadySince = null;
  };
  /** Ready -> not-ready transitions among the pending ones (carried with them, so `BecameUnready` stays exact too). */
  let pendingDown = 0;
  const tracker = transitionTracker<ObservedReadiness>({
    key: (answer) => `${answer.ready ? "ready" : "not-ready"}|${codeList(answer.reasons)}`,
    now: options.now,
    linesPerMinute: options.linesPerMinute,
    onTransition: (from, to, represents) => {
      const down = pendingDown + (from.ready && !to.ready ? 1 : 0);
      const written = options.sink.emit({
        event: "readiness-transition",
        metrics: { ReadinessTransitions: represents, ...(down > 0 ? { BecameUnready: down } : {}) },
        properties: { ...options.properties(), from: from.ready ? "ready" : "not-ready", to: to.ready ? "ready" : "not-ready", from_reasons: codeList(from.reasons), to_reasons: codeList(to.reasons) },
      });
      if (written) pendingDown = 0;
      return written;
    },
    onPending: (from, to) => {
      if (from.ready && !to.ready) pendingDown += 1;
    },
  });
  return {
    observe(answer) {
      note(answer);
      tracker.observe({ ready: answer.ready === true, reasons: [...(answer.reasons ?? [])] });
    },
    gauges(answer) {
      note(answer);
      const isUnready = unready(answer);
      return { Ready: answer.ready ? 1 : 0, Unready: isUnready ? 1 : 0, UnreadySeconds: isUnready && unreadySince !== null ? Math.max(0, Math.floor((options.now() - unreadySince) / 1000)) : 0 };
    },
    pending: () => ({ ReadinessTransitions: tracker.suppressed(), BecameUnready: pendingDown }),
    settle(carried) {
      tracker.settle(carried.ReadinessTransitions);
      pendingDown = Math.max(0, pendingDown - (Number.isSafeInteger(carried.BecameUnready) ? carried.BecameUnready : 0));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Why a task was lost: a fixed code, never the text                    */
/* ------------------------------------------------------------------ */

export type LossCause = "pool-superseded" | "pool-fenced" | "pool-gone" | "generation-moved" | "role-lost" | "other";

/**
 * The cause of a loss, from the reason the pool writer (L5-3) and its reporters (the ownership layer, the identity store,
 * the security journal, the ledger, the relayer role) give -- their texts are this repository's own, pinned by the L6-5A
 * tests (the pool writer's on DynamoDB Local). Only a PROVEN newer task of this pool is `pool-superseded` (the self-check
 * read a HIGHER epoch; a claim found a HIGHER epoch on a game): the one cause `TaskSuperseded` counts. A write or claim
 * refused by the pool fence is `pool-fenced` -- usually the same supersession, but the table cannot say whether the pool
 * item moved forward or went away, so it is NOT counted as superseded. An epoch that went backwards or a pool item that
 * names another task at our epoch is `other`. Anything not recognised is `other`: an alarm treats every cause but
 * `pool-superseded` as UNEXPECTED (the safe direction: it pages).
 */
export function lossCauseOf(reason: string): LossCause {
  const text = String(reason);
  if (/adopted (?:app )?generation moved/.test(text)) return "generation-moved";
  const selfCheck = /^pool \S+ is at epoch (\d+) \(.*\), not this task's (\d+)$/.exec(text);
  if (selfCheck !== null) return Number(selfCheck[1]) > Number(selfCheck[2]) ? "pool-superseded" : "other";
  if (/ is claimed by a newer task of pool \S+ \(epoch \d+\)$/.test(text)) return "pool-superseded";
  if (/refused by the pool fence/.test(text)) return "pool-fenced";
  if (/^the pool item POOL#\S+ is gone/.test(text)) return "pool-gone";
  if (/role is no longer this task's|role was taken over|relayer role moved|a newer relayer holds the relayer fence/.test(text)) return "role-lost";
  return "other";
}

/* ------------------------------------------------------------------ */
/* KMS: deltas of the ONE set of counters (`kmsGate.ts`)                */
/* ------------------------------------------------------------------ */

/** The fields of `KmsCounters` this module reads (structurally; it never counts anything itself). */
export interface KmsCounterView {
  readonly signs: number;
  readonly withheld: number;
  readonly transient: number;
  readonly refused: number;
  readonly invalidAnswer: number;
  readonly other: number;
  readonly lastFailureAt: number | null;
}

/** `KmsCounters` field -> metric. `withheld` is a Sign the pool writer's gate stopped BEFORE KMS was called; `transient`,
 *  `refused`, `invalidAnswer` and `other` are KMS calls (Sign or GetPublicKey) that failed in that class. */
export const KMS_METRIC_OF = Object.freeze({
  signs: "KmsSigns",
  withheld: "KmsSignWithheld",
  transient: "KmsTransient",
  refused: "KmsRefused",
  invalidAnswer: "KmsInvalidAnswer",
  other: "KmsOtherFailure",
} as const satisfies Record<Exclude<keyof KmsCounterView, "lastFailureAt">, MetricName>);

/** The KMS deltas since `sent` (the counters as they were when the last line carrying them was written). */
export function kmsDeltas(current: KmsCounterView, sent: KmsCounterView | null): Partial<Record<MetricName, number>> {
  const out: Partial<Record<MetricName, number>> = {};
  for (const [field, metric] of Object.entries(KMS_METRIC_OF) as Array<[keyof typeof KMS_METRIC_OF, MetricName]>) {
    const now = current[field];
    const before = sent === null ? 0 : sent[field];
    out[metric] = Number.isFinite(now) && Number.isFinite(before) && now >= before ? now - before : 0;
  }
  return out;
}

/** A frozen copy of the counters (what "sent" remembers). */
export const snapshotKms = (counters: KmsCounterView): KmsCounterView => Object.freeze({ signs: counters.signs, withheld: counters.withheld, transient: counters.transient, refused: counters.refused, invalidAnswer: counters.invalidAnswer, other: counters.other, lastFailureAt: counters.lastFailureAt });
