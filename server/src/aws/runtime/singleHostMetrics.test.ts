// server/src/aws/runtime/singleHostMetrics.test.ts
//
// COST-1: the `single-host` metric profile (`runtimeMetrics.ts`). What is pinned:
//   default    absent / `full` is byte-for-byte L6-5A's output; anything else is refused (never silently ignored)
//   lines      every value and property of a record stays in its line (Logs Insights reads them all); only the two
//              derived series are extracted, under [Environment] alone; a record with nothing to extract has no `_aws`
//   health     HostHealthProblems counts each standing problem of a `task-status` tick; 0 when healthy
//   critical   HostCriticalEvents sums the incident counters, only when > 0; routine counters never page
//   harmless   a sink that throws is still counted and never throws (as `full`)

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  buildEmfRecord,
  createEmfSink,
  METRIC_NAMESPACE,
  METRICS,
  METRICS_PROFILE_ENV,
  metricsProfileSwitch,
  SINGLE_HOST_CRITICAL_COUNTERS,
  SINGLE_HOST_METRICS,
  SINGLE_HOST_SWEEP_STALE_SECONDS,
  singleHostDerived,
  type MetricRecord,
} from "./runtimeMetrics";

const CONTEXT = { environment: "staging", pool: "p1" };
const AT = 1_760_000_000_123;

const HEALTHY_TICK: MetricRecord = {
  event: "task-status",
  metrics: {
    Ready: 1,
    Unready: 0,
    UnreadySeconds: 0,
    Standby: 0,
    Primary: 1,
    PoolWriterConfirmed: 1,
    PoolWriterCheckAgeSeconds: 1,
    MoneySweepConsecutiveFailures: 0,
    MoneySweepSecondsSinceSuccess: 12,
    RelayerHeld: 1,
    RelayerUsable: 1,
    EscrowActive: 1,
    RelayerOpenIntents: 0,
    RelayerPaging: 0,
    RelayerWaiting: 0,
    KmsSigns: 3,
    KmsTransient: 0,
    KmsSignWithheld: 0,
    KmsRefused: 0,
  },
  properties: { task: "t-1", build: "b1", role: "primary", phase: "serving", ready: true, reasons: "none" },
};

function linesOf(profile: "full" | "single-host" | undefined, record: MetricRecord): string[] {
  const lines: string[] = [];
  const sink = createEmfSink({ context: CONTEXT, now: () => AT, write: (line) => lines.push(line), ...(profile === undefined ? {} : { profile }) });
  sink.emit(record);
  return lines;
}

function directivesOf(line: Record<string, unknown>): Array<{ Namespace: string; Dimensions: string[][]; Metrics: Array<{ Name: string; Unit: string }> }> {
  return ((line._aws as { CloudWatchMetrics: unknown[] } | undefined)?.CloudWatchMetrics ?? []) as Array<{ Namespace: string; Dimensions: string[][]; Metrics: Array<{ Name: string; Unit: string }> }>;
}

describe("COST-1: the single-host metric profile", () => {
  test("the switch: absent or `full` is full, `single-host` is single-host, anything else is refused by name", () => {
    assert.deepEqual(metricsProfileSwitch(undefined), { ok: true, profile: "full" });
    assert.deepEqual(metricsProfileSwitch("full"), { ok: true, profile: "full" });
    assert.deepEqual(metricsProfileSwitch("single-host"), { ok: true, profile: "single-host" });
    for (const bad of ["", "single_host", "Single-Host", "none", " full"]) {
      const answer = metricsProfileSwitch(bad);
      assert.equal(answer.ok, false, bad);
      if (!answer.ok) assert.match(answer.reason, new RegExp(METRICS_PROFILE_ENV));
    }
  });

  test("the default (no profile) and `full` write exactly L6-5A's bytes", () => {
    for (const record of [HEALTHY_TICK, { event: "task-lost", metrics: { TaskLost: 1 }, properties: { task: "t-1", cause: "pool-superseded" } } as MetricRecord]) {
      const expected = JSON.stringify(buildEmfRecord(CONTEXT, AT, record));
      assert.deepEqual(linesOf(undefined, record), [expected]);
      assert.deepEqual(linesOf("full", record), [expected]);
    }
  });

  test("single-host keeps every value and property in the line, but extracts ONLY HostHealthProblems under [Environment]", () => {
    const [text] = linesOf("single-host", HEALTHY_TICK);
    const line = JSON.parse(text) as Record<string, unknown>;
    const full = buildEmfRecord(CONTEXT, AT, HEALTHY_TICK)!;
    for (const [name, value] of Object.entries(full)) if (name !== "_aws") assert.deepEqual(line[name], value, name);
    assert.equal(line.HostHealthProblems, 0);
    const directives = directivesOf(line);
    assert.equal(directives.length, 1);
    assert.equal(directives[0].Namespace, METRIC_NAMESPACE);
    assert.deepEqual(directives[0].Dimensions, [["Environment"]]);
    assert.deepEqual(directives[0].Metrics, [{ Name: "HostHealthProblems", Unit: "Count" }]);
    for (const name of Object.keys(METRICS)) assert.ok(!directives[0].Metrics.some((metric) => metric.Name === name), `${name} is never extracted`);
  });

  test("a record with nothing to extract is a plain JSON line (no _aws), still carrying its values", () => {
    const routine: MetricRecord = { event: "money-sweep", metrics: { MoneySweepPasses: 1, MoneySweepClaimed: 0, MoneySweepOwned: 2 }, properties: { why: "periodic" } };
    const [text] = linesOf("single-host", routine);
    const line = JSON.parse(text) as Record<string, unknown>;
    assert.ok(!("_aws" in line));
    assert.equal(line.MoneySweepPasses, 1);
    assert.equal(line.event, "money-sweep");
    assert.equal(linesOf("single-host", { event: "task-status", metrics: {} }).length, 0, "an empty record writes nothing, as `full`");
  });

  test("HostHealthProblems counts each standing problem of a tick", () => {
    const tick = (overrides: Partial<Record<keyof typeof METRICS, number>>, drop: Array<keyof typeof METRICS> = []): number => {
      const metrics: Record<string, number> = { ...(HEALTHY_TICK.metrics as Record<string, number>), ...overrides };
      for (const name of drop) delete metrics[name];
      return singleHostDerived({ event: "task-status", metrics }).HostHealthProblems!;
    };
    assert.equal(tick({}), 0);
    assert.equal(tick({ Ready: 0 }), 1);
    assert.equal(tick({ PoolWriterConfirmed: 0 }), 1);
    assert.equal(tick({}, ["PoolWriterConfirmed"]), 1, "an unconfirmed pool writer is a problem, absent or 0");
    assert.equal(tick({ Standby: 1 }), 1, "a single host must be the primary");
    assert.equal(tick({}, ["Primary"]), 1, "no identity writer");
    assert.equal(tick({ MoneySweepSecondsSinceSuccess: SINGLE_HOST_SWEEP_STALE_SECONDS - 1 }), 0);
    assert.equal(tick({ MoneySweepSecondsSinceSuccess: SINGLE_HOST_SWEEP_STALE_SECONDS }), 1);
    assert.equal(tick({ RelayerUsable: 0 }), 1);
    assert.equal(tick({ EscrowActive: 0 }), 1);
    assert.equal(tick({ RelayerPaging: 2 }), 1);
    assert.equal(tick({}, ["RelayerUsable", "EscrowActive", "RelayerPaging", "RelayerHeld"]), 0, "no escrow: no relayer problem");
    assert.equal(tick({ RestoreUnverifiedGames: 1 }), 1, "money games of a restored table still unverified (L6-5B R3)");
    assert.equal(tick({ ClockFinalityHeldTables: 0 }), 0, "no table held at minute 30");
    assert.equal(tick({ ClockFinalityHeldTables: 2 }), 1, "Phase 3 escrow 2.1: timed money tables frozen at an undecided minute 30 (consent keys unread) are ONE standing problem -- the health alarm pages after 3 minutes");
    assert.equal(tick({ ClockFinalityKeysUnread: 7 }), 0, "the per-read counter alone is never a health problem (the gauge is the hold)");
    assert.equal(tick({ KmsTransient: 2, KmsSigns: 0 }), 1, "the signer unavailable this tick (L6-5B A10)");
    assert.equal(tick({ KmsSignWithheld: 1, KmsSigns: 0 }), 1, "signatures withheld, none made");
    assert.equal(tick({ KmsTransient: 2, KmsSigns: 1 }), 0, "a transient failure beside a successful Sign is not a problem");
    assert.equal(tick({ Ready: 0, PoolWriterConfirmed: 0, RelayerUsable: 0, EscrowActive: 0, RelayerPaging: 1, MoneySweepSecondsSinceSuccess: 999 }), 6);
    assert.equal(singleHostDerived({ event: "money-sweep", metrics: { MoneySweepPasses: 1 } }).HostHealthProblems, undefined, "only a status tick is a health sample");
  });

  test("HostCriticalEvents sums the incident counters, only when > 0; routine counters never page", () => {
    for (const name of SINGLE_HOST_CRITICAL_COUNTERS) {
      assert.equal(METRICS[name].kind, "counter", name);
      assert.equal(singleHostDerived({ event: "counters-flush", metrics: { [name]: 2 } }).HostCriticalEvents, 2, name);
    }
    assert.equal(singleHostDerived({ event: "counters-flush", metrics: { TaskLost: 1, KmsRefused: 1, MoneyHeldJournalAhead: 1 } }).HostCriticalEvents, 3);
    for (const routine of ["KmsSigns", "KmsTransient", "KmsSignWithheld", "MoneySweepPasses", "ReadinessTransitions", "RelayerTakeoverTaken", "TaskStatusWriteFailures"] as const) {
      assert.equal(singleHostDerived({ event: "counters-flush", metrics: { [routine]: 5 } }).HostCriticalEvents, undefined, routine);
    }
    const [text] = linesOf("single-host", { event: "task-lost", metrics: { TaskLost: 1, TaskSuperseded: 1 }, properties: { cause: "pool-superseded" } });
    const line = JSON.parse(text) as Record<string, unknown>;
    assert.equal(line.HostCriticalEvents, 1, "a subset counter (TaskSuperseded) is not counted twice");
    assert.deepEqual(directivesOf(line)[0].Metrics, [{ Name: "HostCriticalEvents", Unit: "Count" }]);
    assert.ok(!("HostHealthProblems" in line));
  });

  test("a tick with an incident carries both derived series in one directive", () => {
    const [text] = linesOf("single-host", { ...HEALTHY_TICK, metrics: { ...HEALTHY_TICK.metrics, KmsInvalidAnswer: 1, Ready: 0 } });
    const line = JSON.parse(text) as Record<string, unknown>;
    assert.equal(line.HostHealthProblems, 1);
    assert.equal(line.HostCriticalEvents, 1);
    assert.deepEqual(directivesOf(line)[0].Metrics.map((metric) => metric.Name), Object.keys(SINGLE_HOST_METRICS));
  });

  test("harmless: a sink that throws is counted and never throws", () => {
    const sink = createEmfSink({
      context: CONTEXT,
      now: () => AT,
      profile: "single-host",
      write: () => {
        throw new Error("EPIPE");
      },
    });
    assert.equal(sink.emit(HEALTHY_TICK), false);
    assert.equal(sink.failures(), 1);
  });
});

describe("Phase 3 escrow 2.1: the minute-30 hold's metrics carry counts only", () => {
  test("ClockFinalityHeldTables (gauge) and ClockFinalityKeysUnread (counter) are catalog metrics under [Environment, Pool]; a game, key or signature never rides along", () => {
    assert.deepEqual(METRICS.ClockFinalityHeldTables, { kind: "gauge", unit: "Count", scope: "pool" });
    assert.deepEqual(METRICS.ClockFinalityKeysUnread, { kind: "counter", unit: "Count", scope: "pool" });
    const line = buildEmfRecord(CONTEXT, AT, {
      event: "task-status",
      metrics: { ClockFinalityHeldTables: 1, ClockFinalityKeysUnread: 4 },
      /* What a careless caller might pass: none of it may reach the line (properties are an allow-list). */
      properties: { game_id: "g_00000000000000000000000020", signature: "22".repeat(64), consent_pubkey: "03" + "ab".repeat(32) } as never,
    })!;
    assert.equal(line.ClockFinalityHeldTables, 1);
    assert.equal(line.ClockFinalityKeysUnread, 4);
    const text = JSON.stringify(line);
    for (const secret of ["g_00000000000000000000000020", "22".repeat(64), "ab".repeat(32), "game_id", "signature", "consent_pubkey"]) assert.ok(!text.includes(secret), secret);
    const directives = (line._aws as { CloudWatchMetrics: Array<{ Dimensions: string[][]; Metrics: Array<{ Name: string }> }> }).CloudWatchMetrics;
    for (const d of directives) if (d.Metrics.some((m) => m.Name.startsWith("ClockFinality"))) assert.deepEqual(d.Dimensions, [["Environment", "Pool"]]);
  });
});
