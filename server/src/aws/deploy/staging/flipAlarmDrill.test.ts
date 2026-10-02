/* LIVE-6 L6-6: the flip drill's alarm observations -- the probe program, its launch evidence, every phase's refusals,
 * the final record against the UNCHANGED judge, and run-flip-alarm-probe.ps1 against a stub AWS CLI. No AWS. */
import { strict as assert } from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, test } from "node:test";

import { ALARM_CONTRACT } from "../../controlPlane/alarmContract";
import { buildEmfRecord, METRIC_NAMESPACE } from "../../runtime/runtimeMetrics";
import { storageKindOf } from "../../runtime/storageMode";
import { CERTIFIER_STORAGE_OVERRIDE } from "./certify";
import { judgeFlipAlarmDrill } from "./drills";
import {
  EXIT_NOT_YET,
  FLIP_ALARM_FILES,
  HOLD_DEFAULT_SECONDS,
  HOLD_MAX_SECONDS,
  observeA1,
  observeAfter,
  observeDuring,
  PROBE_PROGRAM,
  probeOverrides,
  probeTaskOf,
  recordFlipAlarms,
  stagePhase,
  STARTED_BY,
  suppressorStates,
  windowOpen,
} from "./flipAlarmDrill";

const RUN = "l6flip-20261002x";
const ENV = "staging";
/** runtimeMetrics.js as compiled next to this test (dist/server/src/aws/runtime): the image's module, built the same way. */
const METRICS_MODULE = path.join(__dirname, "..", "..", "runtime", "runtimeMetrics.js");
const SERVER_ROOT = path.join(__dirname, "..", "..", "..", "..", "..", "..");
const REPO_ROOT = path.join(SERVER_ROOT, "..");
const at = (iso: string) => Date.parse(iso);
const WINDOW = { opened_at: at("2026-10-02T02:00:00Z"), expires_at: at("2026-10-02T02:45:00Z") };

function write(dir: string, file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), typeof value === "string" ? value : JSON.stringify(value));
}

/** L6-2's flip record, p1 -> p2 (the real drill's direction), its window open unless `closed_at` is given. */
function flipRecord(closedAt: number | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  const snap = (t: number, epochs: [number, number], primary: string) => ({ at: t, pools: { p1: { epoch: epochs[0], task: `t-p1-${epochs[0]}` }, p2: { epoch: epochs[1], task: `t-p2-${epochs[1]}` } }, identity_writer: { epoch: 9, pool: primary, task: `t-${primary}` }, relayer: { epoch: 9, pool: primary, task: `t-${primary}` } });
  return {
    format: "18COSMOS/FLIP-EVIDENCE/v1",
    environment: ENV,
    from: "p1",
    to: "p2",
    expected_version: 1,
    note: "l6-6 flip drill",
    verdict: "roles-settled",
    preflight: { at: WINDOW.opened_at - 60_000, checks: [] },
    before: snap(WINDOW.opened_at - 1000, [4, 1], "p1"),
    cas: { at: WINDOW.opened_at + 1000, run: "op:r-0123abcd", outcome: "applied", version: 2, detail: "" },
    window: { ...WINDOW, closed_at: closedAt, suppression: closedAt === null ? "open" : "closed" },
    observations: [],
    after: snap(WINDOW.opened_at + 120_000, [5, 2], "p2"),
    ...over,
  };
}

const TD = "arn:aws:ecs:us-east-1:111111111111:task-definition/gs-staging-p1:1";
function probeTask(mode: "inject" | "hold", pool: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const o = probeOverrides({ mode, environment: ENV, pool, run: RUN, ...(mode === "hold" ? { holdSeconds: 4500 } : {}) }) as any;
  return {
    taskArn: `arn:aws:ecs:us-east-1:111111111111:task/gs-staging/${mode === "inject" ? "e3".repeat(16) : "h0".repeat(16)}`,
    taskDefinitionArn: TD,
    group: "family:gs-staging-p1",
    startedBy: STARTED_BY[mode],
    lastStatus: mode === "inject" ? "STOPPED" : "RUNNING",
    createdAt: "2026-10-02T02:03:00.000000+00:00",
    startedAt: "2026-10-02T02:03:30.000000+00:00",
    ...(mode === "inject" ? { stoppedAt: "2026-10-02T02:04:00.000000+00:00" } : {}),
    containers: [{ name: "game-server", imageDigest: "sha256:" + "ab".repeat(32), ...(mode === "inject" ? { exitCode: 3 } : {}) }],
    overrides: { containerOverrides: o.containerOverrides },
    ...extra,
  };
}

const emfLine = (pool: string, metrics: Record<string, number>, event: "task-lost" | "task-status") => JSON.stringify(buildEmfRecord({ environment: ENV, pool }, at("2026-10-02T02:03:58Z"), { event, metrics }));
const metricAlarm = (name: string, state: string, extra: Record<string, unknown> = {}) => ({ AlarmName: name, StateValue: state, ActionsEnabled: true, ...extra });
/** A composite as DescribeAlarms returns it: `"absent"` OMITS ActionsSuppressedBy (AWS's real shape when not suppressed). */
const composite = (name: string, state: string, suppressedBy: string | null, pool: string) => ({ AlarmName: name, StateValue: state, ActionsEnabled: true, ActionsSuppressor: `gs-staging-${pool}-flip-window`, ...(suppressedBy === "absent" ? {} : { ActionsSuppressedBy: suppressedBy }), AlarmRule: `ALARM("${name.replace(/-notify$/, "")}")` });
const HELD = "gs-staging-p2-a12b-pool-writer-unconfirmed";
function alarms(over: { suppressors?: Record<string, string>; held?: string; notify?: string; suppressedBy?: string | null; a1?: Record<string, unknown>; extraComposites?: unknown[] } = {}) {
  const sup = over.suppressors ?? { p1: "ALARM", p2: "ALARM" };
  return {
    MetricAlarms: [
      metricAlarm("gs-staging-a1-unexpected-task-loss", "ALARM", over.a1 ?? {}),
      ...Object.entries(sup).map(([p, s]) => metricAlarm(`gs-staging-${p}-flip-window`, s)),
      metricAlarm(HELD, over.held ?? "ALARM"),
    ],
    CompositeAlarms: [composite(`${HELD}-notify`, over.notify ?? "ALARM", over.suppressedBy === undefined ? "Alarm" : over.suppressedBy, "p2"), ...(over.extraComposites ?? [])],
  };
}
const history = (items: Array<{ at: string; to: string }>) => ({ AlarmHistoryItems: items.map((i) => ({ AlarmName: "gs-staging-a1-unexpected-task-loss", HistoryItemType: "StateUpdate", Timestamp: i.at, HistoryData: JSON.stringify({ oldState: { stateValue: "OK" }, newState: { stateValue: i.to } }) })) });

/** An evidence directory with every capture the happy path needs (each phase's raw files). */
function drillDir(over: { closedAt?: number | null; inject?: Record<string, unknown>; holdPool?: string; a1Alarms?: unknown; a1History?: unknown; during?: unknown; duringStamp?: [number, number]; after?: unknown; afterStamp?: [number, number]; log?: unknown } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-flipalarm-"));
  write(dir, "flip-record.json", flipRecord(over.closedAt === undefined ? null : over.closedAt));
  const inject = probeTask("inject", "p1", over.inject ?? {});
  write(dir, FLIP_ALARM_FILES.injectTask, { tasks: [inject], failures: [] });
  write(dir, FLIP_ALARM_FILES.injectLogStream, { log_group: "/gs/staging/p1", log_stream: `gs/game-server/${String(inject.taskArn).split("/").pop()}` });
  write(dir, FLIP_ALARM_FILES.injectLog, over.log ?? { events: [{ message: emfLine("p1", { TaskLost: 1, TaskSuperseded: 0 }, "task-lost") }, { message: "L6-6-FLIP-ALARM-PROBE {}" }] });
  write(dir, FLIP_ALARM_FILES.raw("a1", "alarms"), over.a1Alarms ?? alarms());
  write(dir, FLIP_ALARM_FILES.raw("a1", "history"), over.a1History ?? history([{ at: "2026-10-02T02:05:10.000000+00:00", to: "ALARM" }]));
  write(dir, FLIP_ALARM_FILES.holdTask, { tasks: [probeTask("hold", over.holdPool ?? "p2")], failures: [] });
  const [df, dt] = over.duringStamp ?? [at("2026-10-02T02:10:00Z"), at("2026-10-02T02:10:02Z")];
  write(dir, FLIP_ALARM_FILES.raw("during", "alarms"), over.during ?? alarms());
  write(dir, FLIP_ALARM_FILES.raw("during", "stamp"), { captured_from: df, captured_to: dt });
  const [af, atTo] = over.afterStamp ?? [at("2026-10-02T02:30:00Z"), at("2026-10-02T02:30:02Z")];
  write(dir, FLIP_ALARM_FILES.raw("after", "alarms"), over.after ?? alarms({ suppressors: { p1: "OK", p2: "OK" }, suppressedBy: "absent" }));
  write(dir, FLIP_ALARM_FILES.raw("after", "stamp"), { captured_from: af, captured_to: atTo });
  return dir;
}
const ctxOf = (dir: string, pools = ["p1", "p2"]) => ({ dir, run: RUN, environment: ENV, pools });
const cleanup = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });
const reasons = (v: { kind: string; reasons?: readonly string[] }) => (v.reasons ?? []).join("\n");

/* ------------------------------------------------------------------ */

describe("flip alarm probe: the program and its overrides never start a game server", () => {
  test("the overrides run node -e PROBE_PROGRAM with GS_STORAGE = the certifier's refusing value (start.ts refuses it)", () => {
    const o = probeOverrides({ mode: "inject", environment: ENV, pool: "p1", run: RUN }) as any;
    const c = o.containerOverrides[0];
    assert.equal(c.name, "game-server");
    assert.deepEqual(c.command.slice(0, 2), ["node", "-e"]);
    assert.equal(c.command[2], PROBE_PROGRAM);
    const env = Object.fromEntries(c.environment.map((e: any) => [e.name, e.value]));
    assert.equal(env.GS_STORAGE, CERTIFIER_STORAGE_OVERRIDE);
    assert.equal(storageKindOf([], { GS_STORAGE: env.GS_STORAGE }).ok, false, "a lost command override: start.ts refuses this storage");
    assert.deepEqual([env.FA_MODE, env.FA_ENVIRONMENT, env.FA_POOL, env.FA_RUN], ["inject", ENV, "p1", RUN]);
    assert.ok(!/start|gameServer|awsMain|awsRuntime|dynamo|kms|routing|escrow/i.test(PROBE_PROGRAM.replace(/runtimeMetrics\.js/g, "")), "the program reaches nothing but the metrics encoder");
    assert.match(PROBE_PROGRAM, /require\(e\.FA_METRICS_MODULE\|\|'\/app\/server\/dist\/server\/src\/aws\/runtime\/runtimeMetrics\.js'\)/);
  });

  test("the hold is bounded; prod and malformed inputs are refused", () => {
    const env = (o: any) => Object.fromEntries(o.containerOverrides[0].environment.map((e: any) => [e.name, e.value]));
    assert.equal(env(probeOverrides({ mode: "hold", environment: ENV, pool: "p2", run: RUN })).FA_HOLD_SECONDS, String(HOLD_DEFAULT_SECONDS));
    for (const holdSeconds of [HOLD_MAX_SECONDS + 1, 599, 0, 1.5]) assert.throws(() => probeOverrides({ mode: "hold", environment: ENV, pool: "p2", run: RUN, holdSeconds }), /hold-seconds/);
    assert.throws(() => probeOverrides({ mode: "inject", environment: "production", pool: "p1", run: RUN }), /non-prod/);
    assert.throws(() => probeOverrides({ mode: "inject", environment: ENV, pool: "P1", run: RUN }), /pool/);
  });

  const runProgram = (env: Record<string, string>, timeout = 20_000) => spawnSync(process.execPath, ["-e", PROBE_PROGRAM], { env: { ...process.env, FA_METRICS_MODULE: METRICS_MODULE, ...env }, encoding: "utf8", timeout });
  const emfOf = (stdout: string) => stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));

  test("inject: one EMF record TaskLost=1 / TaskSuperseded=0 through the production encoder, then exit 3", () => {
    const r = runProgram({ FA_MODE: "inject", FA_ENVIRONMENT: ENV, FA_POOL: "p1", FA_RUN: RUN });
    assert.equal(r.status, 3, r.stderr);
    const [line, ...more] = emfOf(r.stdout);
    assert.equal(more.length, 0);
    assert.equal(line.TaskLost, 1);
    assert.equal(line.TaskSuperseded, 0);
    assert.equal(line.Environment, ENV);
    assert.equal(line.event, "task-lost");
    const expected = buildEmfRecord({ environment: ENV, pool: "p1" }, line._aws.Timestamp, { event: "task-lost", metrics: { TaskLost: 1, TaskSuperseded: 0 }, properties: { cause: "other", why: "l6-6-flip-alarm-drill" } });
    assert.deepEqual(line._aws.CloudWatchMetrics[0].Dimensions, [["Environment", "Pool"], ["Environment"]], "A1 reads the [Environment] series");
    assert.equal(line._aws.CloudWatchMetrics[0].Namespace, METRIC_NAMESPACE);
    assert.deepEqual(line, expected, "byte-for-byte what createEmfSink writes");
    assert.match(r.stdout, /L6-6-FLIP-ALARM-PROBE .*"emitted":true,"exit":3/);
  });

  test("hold: PoolWriterConfirmed=0 under exactly the A12b dimensions [Environment, Pool], repeatedly, then a bounded exit 0", () => {
    const r = runProgram({ FA_MODE: "hold", FA_ENVIRONMENT: ENV, FA_POOL: "p2", FA_RUN: RUN, FA_HOLD_SECONDS: "1", FA_TICK_MS: "200" });
    assert.equal(r.status, 0, r.stderr);
    const lines = emfOf(r.stdout);
    assert.ok(lines.length >= 3, `${lines.length} lines`);
    const spec = ALARM_CONTRACT.alarms.find((a) => a.id === "a12b-pool-writer-unconfirmed");
    assert.ok(spec?.suppressible === true && spec.scope === "pool" && spec.metrics.some((m: any) => m.metric === "PoolWriterConfirmed"));
    for (const l of lines) {
      assert.equal(l.PoolWriterConfirmed, 0);
      assert.equal(l.Pool, "p2");
      assert.equal(l.Environment, ENV);
      assert.deepEqual(l._aws.CloudWatchMetrics, [{ Namespace: METRIC_NAMESPACE, Dimensions: [["Environment", "Pool"]], Metrics: [{ Name: "PoolWriterConfirmed", Unit: "None" }] }]);
    }
    assert.match(r.stdout, /"done":"max-duration"/);
    for (const bad of [{ FA_HOLD_SECONDS: String(HOLD_MAX_SECONDS + 1) }, { FA_ENVIRONMENT: "prod-1" }, { FA_MODE: "serve" }, { FA_TICK_MS: "5" }]) {
      const refused = runProgram({ FA_MODE: "hold", FA_ENVIRONMENT: ENV, FA_POOL: "p2", FA_RUN: RUN, FA_HOLD_SECONDS: "1", FA_TICK_MS: "200", ...bad });
      assert.equal(refused.status, 2, JSON.stringify(bad));
      assert.equal(emfOf(refused.stdout).length, 0, "nothing emitted before a refusal");
    }
  });
});

describe("flip alarm probe: launch evidence", () => {
  test("the task's identity is captured; anything but the drill's own standalone program is refused", () => {
    const got = probeTaskOf({ tasks: [probeTask("inject", "p1")] }, "inject", ENV);
    assert.equal(got.problem, null);
    assert.deepEqual({ ...got.task }, { taskArn: `arn:aws:ecs:us-east-1:111111111111:task/gs-staging/${"e3".repeat(16)}`, taskDefinitionArn: TD, lastStatus: "STOPPED", createdAt: at("2026-10-02T02:03:00Z"), startedAt: at("2026-10-02T02:03:30Z"), stoppedAt: at("2026-10-02T02:04:00Z"), exitCode: 3, imageDigest: "sha256:" + "ab".repeat(32), pool: "p1" });
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ group: "service:gs-staging-p1" }, /belongs to a service/],
      [{ startedBy: "ecs-svc/123" }, /started by/],
      [{ overrides: { containerOverrides: [{ name: "game-server", command: ["node", "dist/server/src/start.js"] }] } }, /does not run the drill's program/],
      [{ overrides: { containerOverrides: [{ ...(probeTask("inject", "p1").overrides as any).containerOverrides[0], environment: [{ name: "GS_STORAGE", value: "aws" }, { name: "FA_MODE", value: "inject" }, { name: "FA_ENVIRONMENT", value: ENV }] }] } }, /GS_STORAGE/],
    ];
    for (const [extra, why] of bad) assert.match(String(probeTaskOf({ tasks: [probeTask("inject", "p1", extra)] }, "inject", ENV).problem), why);
    assert.match(String(probeTaskOf({ tasks: [] }, "inject", ENV).problem), /exactly one/);
    assert.match(String(probeTaskOf({ tasks: [probeTask("hold", "p2")] }, "inject", ENV).problem), /started by/);
  });
});

describe("flip alarm recorder: each phase from AWS captures, never invented", () => {
  test("a1: the standalone exit 3 inside the window, then A1 ALARM with actions not suppressed", () => {
    const dir = drillDir();
    try {
      const v = observeA1(ctxOf(dir));
      assert.equal(v.kind, "observed", reasons(v as any));
      const o = (v as any).value;
      assert.equal(o.exit_code, 3);
      assert.equal(o.stopped_at, at("2026-10-02T02:04:00Z"));
      assert.equal(o.alarm_at, at("2026-10-02T02:05:10Z"));
      assert.equal(o.actions_suppressed, false);
      assert.match(o.log_stream, /^gs\/game-server\/e3e3/);
    } finally {
      cleanup(dir);
    }
    const refusals: Array<[Parameters<typeof drillDir>[0], RegExp]> = [
      [{ inject: { containers: [{ name: "game-server", exitCode: 2 }] } }, /exited 2, not 3/],
      [{ inject: { stoppedAt: "2026-10-02T01:59:00.000000+00:00" } }, /outside the flip window/],
      [{ closedAt: at("2026-10-02T02:03:00Z") }, /outside the flip window/],
      [{ a1Alarms: alarms({ a1: { ActionsEnabled: false } }) }, /actions are suppressed/],
      [{ a1Alarms: alarms({ extraComposites: [{ AlarmName: "x-notify", StateValue: "OK", ActionsSuppressor: "gs-staging-p1-flip-window", AlarmRule: 'ALARM("gs-staging-a1-unexpected-task-loss")' }] }) }, /wrapped by a suppressed composite/],
      [{ log: { events: [{ message: emfLine("p1", { TaskLost: 1, TaskSuperseded: 1 }, "task-lost") }] } }, /no EMF record TaskLost=1 \/ TaskSuperseded=0/],
      [{ a1Alarms: { MetricAlarms: [], CompositeAlarms: [] } }, /not in describe-alarms/],
    ];
    for (const [over, why] of refusals) {
      const d = drillDir(over);
      try {
        const v = observeA1(ctxOf(d));
        assert.equal(v.kind, "refused", `${JSON.stringify(over)}: ${v.kind}`);
        assert.match(reasons(v as any), why);
      } finally {
        cleanup(d);
      }
    }
    for (const a1History of [{ AlarmHistoryItems: [] }, history([{ at: "2026-10-02T02:03:50.000000+00:00", to: "ALARM" }]), history([{ at: "2026-10-02T02:05:10.000000+00:00", to: "OK" }]), history([{ at: "2026-10-02T03:00:00.000000+00:00", to: "ALARM" }])]) {
      const d = drillDir({ a1History });
      try {
        assert.equal(observeA1(ctxOf(d)).kind, "not-yet", "absent / earlier / non-ALARM / unbound history is never filled in");
        assert.equal(stagePhase(ctxOf(d), "a1").kind, "not-yet");
        assert.equal(fs.existsSync(path.join(d, FLIP_ALARM_FILES.observation("a1"))), false);
      } finally {
        cleanup(d);
      }
    }
  });

  test("during: inside the window, the held alarm suppressed by ITS pool's window, exactly the flip's suppressors ALARM", () => {
    const dir = drillDir();
    try {
      const v = observeDuring(ctxOf(dir));
      assert.equal(v.kind, "observed", reasons(v as any));
      assert.deepEqual((v as any).value.suppressors.states, { p1: "ALARM", p2: "ALARM" });
      assert.equal((v as any).value.alarm, HELD);
    } finally {
      cleanup(dir);
    }
    const refusals: Array<[Parameters<typeof drillDir>[0], string[] | undefined, RegExp]> = [
      [{ duringStamp: [at("2026-10-02T01:59:00Z"), at("2026-10-02T02:00:30Z")] }, undefined, /before the window opened/],
      [{ duringStamp: [at("2026-10-02T02:44:59Z"), at("2026-10-02T02:45:01Z")] }, undefined, /at or after the window's end/],
      [{ during: alarms({ suppressors: { p1: "ALARM", p2: "ALARM", p3: "ALARM" } }) }, ["p1", "p2", "p3"], /another pool's suppressor is ALARM/],
      [{ during: alarms({ suppressors: { p1: "ALARM", p2: "ALARM", p9: "OK" } }) }, undefined, /outside the deployment: p9/],
      [{ holdPool: "p3" }, ["p1", "p2", "p3"], /not one of the flip's pools/],
      [{ during: { ...alarms(), CompositeAlarms: [{ ...composite(`${HELD}-notify`, "ALARM", "Alarm", "p2"), ActionsSuppressor: "gs-staging-p1-flip-window" }] } }, undefined, /not gs-staging-p2-flip-window/],
    ];
    for (const [over, pools, why] of refusals) {
      const d = drillDir(over);
      try {
        const v = observeDuring(ctxOf(d, pools));
        assert.equal(v.kind, "refused", `${JSON.stringify(over).slice(0, 80)}: ${v.kind} ${reasons(v as any)}`);
        assert.match(reasons(v as any), why);
      } finally {
        cleanup(d);
      }
    }
    for (const during of [alarms({ suppressors: { p1: "OK", p2: "ALARM" } }), alarms({ suppressors: { p1: "ALARM", p2: "INSUFFICIENT_DATA" } }), alarms({ held: "OK" }), alarms({ suppressedBy: "WaitPeriod" }), alarms({ notify: "OK" })]) {
      const d = drillDir({ during });
      try {
        assert.notEqual(observeDuring(ctxOf(d)).kind, "observed", "either flip suppressor not ALARM, or the held alarm not yet suppressed-ALARM, is never recorded");
      } finally {
        cleanup(d);
      }
    }
  });

  test("after: only at/after the window's actual end, the condition still failing, actions no longer suppressed", () => {
    const closed = at("2026-10-02T02:20:00Z");
    const dir = drillDir({ closedAt: closed });
    try {
      assert.equal(observeAfter(ctxOf(dir)).kind, "refused", "the 'during' phase must be staged first");
      write(dir, "flip-record.json", flipRecord(null));
      assert.equal(stagePhase(ctxOf(dir), "during").kind, "observed");
      write(dir, "flip-record.json", flipRecord(closed));
      const v = observeAfter(ctxOf(dir));
      assert.equal(v.kind, "observed", reasons(v as any));
      assert.deepEqual((v as any).value.after, { at: at("2026-10-02T02:30:00Z"), composite_state: "ALARM", actions_suppressed_by: "None", alarm_state: "ALARM" });
      for (const [after, stamp, kind, why] of [
        [alarms({ suppressedBy: "Alarm" }), undefined, "not-yet", /waiting for no suppression/],
        [alarms({ suppressedBy: "WaitPeriod" }), undefined, "not-yet", /waiting for no suppression/],
        [alarms({ suppressedBy: "ExtensionPeriod" }), undefined, "not-yet", /waiting for no suppression/],
        [alarms({ suppressedBy: "None" }), undefined, "refused", /not a CloudWatch suppression state/],
        [alarms({ suppressedBy: "Bogus" }), undefined, "refused", /not a CloudWatch suppression state/],
        [alarms({ suppressedBy: "absent", notify: "OK" }), undefined, "not-yet", /is OK/],
        [alarms({ suppressedBy: "absent" }), [at("2026-10-02T02:19:00Z"), at("2026-10-02T02:19:02Z")], "not-yet", /has not ended/],
        [alarms({ held: "OK", suppressedBy: "absent" }), undefined, "refused", /must still fail/],
      ] as Array<[unknown, [number, number] | undefined, string, RegExp]>) {
        write(dir, FLIP_ALARM_FILES.raw("after", "alarms"), after);
        write(dir, FLIP_ALARM_FILES.raw("after", "stamp"), { captured_from: (stamp ?? [at("2026-10-02T02:30:00Z")])[0], captured_to: (stamp ?? [0, at("2026-10-02T02:30:02Z")])[1] });
        const r = observeAfter(ctxOf(dir));
        assert.equal(r.kind, kind, reasons(r as any));
        assert.match(reasons(r as any), why);
      }
      /* AWS's REAL shape: ActionsSuppressedBy absent (and null, should a parser produce it) -> the canonical "None". */
      for (const suppressedBy of ["absent", null] as const) {
        write(dir, FLIP_ALARM_FILES.raw("after", "alarms"), alarms({ suppressedBy, suppressors: { p1: "OK", p2: "OK" } }));
        write(dir, FLIP_ALARM_FILES.raw("after", "stamp"), { captured_from: at("2026-10-02T02:30:00Z"), captured_to: at("2026-10-02T02:30:02Z") });
        const real = observeAfter(ctxOf(dir));
        assert.equal(real.kind, "observed", `${String(suppressedBy)}: ${reasons(real as any)}`);
        assert.equal((real as any).value.after.actions_suppressed_by, "None");
        if (suppressedBy === "absent") assert.equal("ActionsSuppressedBy" in (alarms({ suppressedBy }).CompositeAlarms[0] as object), false, "the fixture omits the field, as AWS does");
      }
      write(dir, "flip-record.json", flipRecord(null));
      write(dir, FLIP_ALARM_FILES.raw("after", "alarms"), alarms({ suppressedBy: "absent" }));
      write(dir, FLIP_ALARM_FILES.raw("after", "stamp"), { captured_from: at("2026-10-02T02:30:00Z"), captured_to: at("2026-10-02T02:30:02Z") });
      assert.equal(observeAfter(ctxOf(dir)).kind, "not-yet", "a window still open (not closed, not expired) has no 'after'");
    } finally {
      cleanup(dir);
    }
  });

  test("record: the three staged phases make a probe-flip-alarms.json the UNCHANGED judge passes; anything unbound is refused", () => {
    const closed = at("2026-10-02T02:20:00Z");
    const dir = drillDir({ closedAt: null });
    try {
      assert.equal(stagePhase(ctxOf(dir), "a1").kind, "observed");
      assert.equal(stagePhase(ctxOf(dir), "during").kind, "observed");
      assert.equal(recordFlipAlarms(ctxOf(dir)).kind, "refused", "no 'after' yet");
      write(dir, "flip-record.json", flipRecord(closed));
      assert.equal(stagePhase(ctxOf(dir), "after").kind, "observed");
      const v = recordFlipAlarms(ctxOf(dir));
      assert.equal(v.kind, "observed", reasons(v as any));
      const checks = judgeFlipAlarmDrill(dir, { run: RUN, environment: ENV, pools: ["p1", "p2"] });
      assert.ok(checks.length >= 4 && checks.every((c) => c.status === "pass"), JSON.stringify(checks));
      const rec = JSON.parse(fs.readFileSync(path.join(dir, "probe-flip-alarms.json"), "utf8"));
      assert.deepEqual(rec.flip, { from: "p1", to: "p2", opened_at: WINDOW.opened_at, expires_at: WINDOW.expires_at, closed_at: closed });
      assert.equal(rec.run_id, RUN);
      /* Bound to THIS flip: another window, another run, mixed alarms -- refused, and the file is not rewritten. */
      fs.rmSync(path.join(dir, "probe-flip-alarms.json"));
      write(dir, "flip-record.json", flipRecord(closed, { window: { opened_at: WINDOW.opened_at + 1, expires_at: WINDOW.expires_at, closed_at: closed, suppression: "closed" } }));
      assert.match(reasons(recordFlipAlarms(ctxOf(dir)) as any), /bound to another flip window/);
      assert.equal(fs.existsSync(path.join(dir, "probe-flip-alarms.json")), false);
      write(dir, "flip-record.json", flipRecord(closed));
      assert.match(reasons(recordFlipAlarms({ ...ctxOf(dir), run: "l6flip-other-run" }) as any), /not this run's/);
      const after = JSON.parse(fs.readFileSync(path.join(dir, FLIP_ALARM_FILES.observation("after")), "utf8"));
      after.observation.alarm = "gs-staging-p1-a12b-pool-writer-unconfirmed";
      write(dir, FLIP_ALARM_FILES.observation("after"), after);
      assert.match(reasons(recordFlipAlarms(ctxOf(dir)) as any), /one alarm across the window/);
    } finally {
      cleanup(dir);
    }
  });

  test("helpers: suppressors are discovered from CloudWatch; the window gate is the flip record's", () => {
    assert.deepEqual(suppressorStates(alarms({ suppressors: { p1: "ALARM", p2: "OK" } }), ENV), { p1: "ALARM", p2: "OK" });
    const dir = drillDir();
    try {
      assert.equal(windowOpen(dir, at("2026-10-02T02:10:00Z")).open, true);
      assert.equal(windowOpen(dir, at("2026-10-02T02:50:00Z")).open, false);
      write(dir, "flip-record.json", flipRecord(null, { window: null }));
      assert.match(windowOpen(dir, at("2026-10-02T02:10:00Z")).detail, /no window was opened/);
    } finally {
      cleanup(dir);
    }
  });
});

/* ------------------------------------------------------------------ */
/* run-flip-alarm-probe.ps1 against a stub AWS CLI                      */
/* ------------------------------------------------------------------ */

const PWSH = (() => {
  for (const c of process.platform === "win32" ? ["pwsh", "powershell"] : ["pwsh"]) if (spawnSync(c, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8", timeout: 60_000 }).status === 0) return c;
  return null;
})();
const STUB = String.raw`
const fs = require("fs");
const argv = process.argv.slice(2);
const sc = JSON.parse(fs.readFileSync(process.env.STUB_SCENARIO, "utf8"));
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(argv) + "\n");
const op = argv.slice(argv.findIndex((a) => ["ecs", "cloudwatch", "logs"].includes(a))).slice(0, 2).join(" ");
if (op === "cloudwatch describe-alarms") process.stdout.write(JSON.stringify(sc.alarms));
else if (op === "cloudwatch describe-alarm-history") process.stdout.write(JSON.stringify(sc.history));
else { process.stderr.write("stub: unexpected " + op + "\n"); process.exit(254); }
`;

describe("run-flip-alarm-probe.ps1 (stub AWS CLI; no AWS)", () => {
  const skip = PWSH === null ? "PowerShell is not available here" : false;
  function run(mode: string[], dir: string, scenario: Record<string, unknown>) {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "gs-flipalarm-bin-"));
    fs.writeFileSync(path.join(bin, "aws-stub.js"), STUB);
    if (process.platform === "win32") fs.writeFileSync(path.join(bin, "aws.cmd"), `@"${process.execPath}" "%~dp0aws-stub.js" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
    else fs.writeFileSync(path.join(bin, "aws"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "aws-stub.js")}" "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "scenario.json"), JSON.stringify(scenario));
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, STUB_SCENARIO: path.join(bin, "scenario.json"), STUB_LOG: path.join(bin, "calls.log") };
    const r = spawnSync(PWSH as string, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(REPO_ROOT, "infra", "aws", "scripts", "run-flip-alarm-probe.ps1"), ...mode, "-Environment", ENV, "-Region", "us-east-1", "-Run", RUN, "-Out", dir], { env, encoding: "utf8", timeout: 300_000 });
    const calls = fs.existsSync(env.STUB_LOG) ? fs.readFileSync(env.STUB_LOG, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as string[]) : [];
    fs.rmSync(bin, { recursive: true, force: true });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, calls };
  }

  test("inject refuses outside an open window and starts nothing", { skip }, () => {
    const dir = drillDir();
    try {
      const past = { opened_at: at("2020-01-01T00:00:00Z"), expires_at: at("2020-01-01T00:45:00Z"), closed_at: at("2020-01-01T00:20:00Z"), suppression: "closed" };
      write(dir, "flip-record.json", flipRecord(past.closed_at, { window: past }));
      const r = run(["-Mode", "inject", "-Pool", "p1"], dir, {});
      assert.notEqual(r.status, 0, r.out);
      assert.match(r.out, /WINDOW NOT OPEN/);
      assert.deepEqual(r.calls, [], "no AWS call at all: no run-task");
    } finally {
      cleanup(dir);
    }
  });

  test("observe a1 captures describe-alarms + history with a machine stamp and stages the observation", { skip }, () => {
    const dir = drillDir();
    try {
      for (const f of [FLIP_ALARM_FILES.raw("a1", "alarms"), FLIP_ALARM_FILES.raw("a1", "history")]) fs.rmSync(path.join(dir, f));
      const r = run(["-Mode", "observe", "-Phase", "a1", "-Pools", "p1,p2", "-TimeoutSeconds", "30"], dir, { alarms: alarms(), history: history([{ at: "2026-10-02T02:05:10.000000+00:00", to: "ALARM" }]) });
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /OBSERVED/);
      assert.deepEqual(r.calls.map((c) => c.slice(c.indexOf("cloudwatch"), c.indexOf("cloudwatch") + 2).join(" ")), ["cloudwatch describe-alarms", "cloudwatch describe-alarm-history"]);
      const stamp = JSON.parse(fs.readFileSync(path.join(dir, FLIP_ALARM_FILES.raw("a1", "stamp")), "utf8").replace(/^﻿/, ""));
      assert.ok(stamp.captured_to >= stamp.captured_from && stamp.captured_from > at("2026-10-01T00:00:00Z"));
      assert.ok(fs.existsSync(path.join(dir, FLIP_ALARM_FILES.observation("a1"))));
    } finally {
      cleanup(dir);
    }
  });

  test("observe answers NOT YET with exit 10 and stops at its bound; a refusal stops at once", { skip }, () => {
    assert.equal(EXIT_NOT_YET, 10);
    const dir = drillDir();
    try {
      const r = run(["-Mode", "observe", "-Phase", "a1", "-Pools", "p1,p2", "-TimeoutSeconds", "1"], dir, { alarms: alarms(), history: { AlarmHistoryItems: [] } });
      assert.notEqual(r.status, 0);
      assert.match(r.out, /NOT YET[\s\S]*not observed within 1 s/);
      const refused = run(["-Mode", "observe", "-Phase", "a1", "-Pools", "p1,p2", "-TimeoutSeconds", "30"], dir, { alarms: alarms({ a1: { ActionsEnabled: false } }), history: history([{ at: "2026-10-02T02:05:10.000000+00:00", to: "ALARM" }]) });
      assert.notEqual(refused.status, 0);
      assert.match(refused.out, /REFUSED[\s\S]*was refused/);
      assert.equal(refused.calls.length, 2, "one capture, then the refusal: no polling");
    } finally {
      cleanup(dir);
    }
  });
});
