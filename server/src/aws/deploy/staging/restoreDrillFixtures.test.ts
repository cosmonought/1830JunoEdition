/* LIVE-6 L6-6 (restore drill tooling): the restore drill suites' SHARED FIXTURE KIT -- no test of its own. It writes the
 * evidence exactly as run-restore-alarm-probe / run-restore-fence-probe and the in-task probes write it (AWS answers in
 * the CLI's JSON shapes, machine stamps, the probes' own log lines), on one timeline, and lets each suite bend one piece.
 * Named `.test.ts` because it builds the injected EMF lines with the production encoder and decision metric sets
 * (`aws/runtime/runtimeMetrics`), which only the drills' test files may reach (the import guard, awsClients.test.ts). */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { fenceProbeCommand, fenceProbeLine, fenceProbeStartedBy, RESTORE_FENCE_PROBE_FORMAT, type FenceProbeMode } from "../../controlPlane/restoreFence";
import { SUPPRESSION_OVERLAP_FORMAT, SUPPRESSION_OVERLAP_KIND, SUPPRESSION_OVERLAP_STATEMENT } from "../../controlPlane/suppressionOverlap";
import { buildEmfRecord, moneyHeldJournalAheadMetrics, restoreUnverifiedMetrics, startupRefusedMetrics, taskLostMetrics, type MetricRecord } from "../../runtime/runtimeMetrics";
import { CERTIFIER_STORAGE_OVERRIDE } from "./evidence";
import { precheckRestoreCase, recordRestoreAlarms, stageRestoreCase } from "./restoreAlarmDrill";
import { INJECTION_WHY, RESTORE_ALARM_FILES, RESTORE_CASE_ALARM, RESTORE_CASES, restoreProbeOverrides, restoreStartedBy, type RestoreCase } from "./restoreAlarmProbe";
import { RESTORE_FENCE_FILES } from "./restoreFencing";

export const RUN = "l6restore-20261002x";
export const ENV = "staging";
export const POOLS = ["p1", "p2"] as const;
export const at = (iso: string): number => Date.parse(iso);
const isoOf = (ms: number): string => new Date(ms).toISOString();
/** The AWS CLI v2's time format (microseconds, +00:00). */
export const cli = (ms: number): string => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00");

export function write(dir: string, file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), typeof value === "string" ? value : JSON.stringify(value));
}
export const read = (dir: string, file: string): any => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8").replace(/^﻿/, ""));
export const tempDir = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
export const cleanup = (dir: string): void => fs.rmSync(dir, { recursive: true, force: true });

/* ------------------------------------------------------------------ */
/* CloudWatch answers                                                    */
/* ------------------------------------------------------------------ */

export const alarmName = (c: RestoreCase, pool: string): string => (c === "r3" ? `gs-${ENV}-${pool}-${RESTORE_CASE_ALARM[c]}` : `gs-${ENV}-${RESTORE_CASE_ALARM[c]}`);
export const suppressor = (pool: string): string => `gs-${ENV}-${pool}-flip-window`;

/** describe-alarms (prefix gs-<env>-): every restore alarm (R3 per pool), both suppressors, and one suppressible composite. */
export function alarmsDoc(states: Record<string, string> = {}, extra: { readonly metric?: Record<string, Record<string, unknown>>; readonly composites?: unknown[] } = {}): Record<string, unknown> {
  const names = [...RESTORE_CASES.filter((c) => c !== "r3").map((c) => alarmName(c, "p1")), ...POOLS.map((p) => alarmName("r3", p)), ...POOLS.map(suppressor), `gs-${ENV}-a1-unexpected-task-loss`, `gs-${ENV}-p1-a12b-pool-writer-unconfirmed`];
  return {
    MetricAlarms: names.map((n) => ({ AlarmName: n, AlarmArn: `arn:aws:cloudwatch:us-east-1:111111111111:alarm:${n}`, StateValue: states[n] ?? "OK", ActionsEnabled: true, ...(extra.metric?.[n] ?? {}) })),
    CompositeAlarms: [
      { AlarmName: `gs-${ENV}-p1-a12b-pool-writer-unconfirmed-notify`, StateValue: "OK", ActionsEnabled: true, ActionsSuppressor: suppressor("p1"), AlarmRule: `ALARM("gs-${ENV}-p1-a12b-pool-writer-unconfirmed")` },
      ...(extra.composites ?? []),
    ],
  };
}

export function historyDoc(name: string, items: ReadonlyArray<{ readonly at: number; readonly to: string; readonly from?: string }>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    AlarmHistoryItems: [...items]
      .sort((a, b) => b.at - a.at) /* the service answers newest first */
      .map((i) => ({ AlarmName: name, AlarmType: "MetricAlarm", Timestamp: cli(i.at), HistoryItemType: "StateUpdate", HistorySummary: `Alarm updated from ${i.from ?? "OK"} to ${i.to}`, HistoryData: JSON.stringify({ version: "1.0", oldState: { stateValue: i.from ?? "OK" }, newState: { stateValue: i.to } }) })),
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* The probe tasks and their EMF lines                                   */
/* ------------------------------------------------------------------ */

export const TD = (pool: string) => `arn:aws:ecs:us-east-1:111111111111:task-definition/gs-${ENV}-${pool}:7`;
export const taskArnOf = (tag: string): string => `arn:aws:ecs:us-east-1:111111111111:task/gs-${ENV}/${tag.padEnd(32, "0").slice(0, 32)}`;

/** The decision record a case injects (the production builders, exactly as RESTORE_PROBE_PROGRAM sends them). */
export function decisionRecord(c: RestoreCase): MetricRecord {
  if (c === "r1") return { event: "task-lost", metrics: taskLostMetrics("generation-moved"), properties: { why: INJECTION_WHY, cause: "generation-moved" } };
  if (c === "a4g") return { event: "startup-refused", metrics: startupRefusedMetrics("generation"), properties: { why: INJECTION_WHY, refusal: "generation" } };
  if (c === "a4i") return { event: "startup-refused", metrics: startupRefusedMetrics("identity-restore"), properties: { why: INJECTION_WHY, refusal: "identity-restore" } };
  if (c === "r2") return { event: "money-held", metrics: moneyHeldJournalAheadMetrics(), properties: { why: INJECTION_WHY } };
  return { event: "task-status", metrics: restoreUnverifiedMetrics(1), properties: { why: INJECTION_WHY } };
}
export const emfLine = (c: RestoreCase, pool: string, when: number): string => JSON.stringify(buildEmfRecord({ environment: ENV, pool }, when, decisionRecord(c)));

export function restoreProbeTask(c: RestoreCase, pool: string, times: { readonly started: number; readonly stopped: number | null }, extra: Record<string, unknown> = {}, run: string = RUN): Record<string, unknown> {
  const o = restoreProbeOverrides({ case: c, environment: ENV, pool, run }) as any;
  return {
    taskArn: taskArnOf(`${c}a`),
    taskDefinitionArn: TD(pool),
    group: `family:gs-${ENV}-${pool}`,
    startedBy: restoreStartedBy(c),
    lastStatus: times.stopped === null ? "RUNNING" : "STOPPED",
    createdAt: cli(times.started - 30_000),
    startedAt: cli(times.started),
    ...(times.stopped === null ? {} : { stoppedAt: cli(times.stopped) }),
    containers: [{ name: "game-server", imageDigest: `sha256:${"ab".repeat(32)}`, ...(times.stopped === null ? {} : { exitCode: 0 }) }],
    overrides: { containerOverrides: o.containerOverrides },
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* One case, every capture                                              */
/* ------------------------------------------------------------------ */

export interface CaseScript {
  readonly c: RestoreCase;
  readonly pool: string;
  readonly overlap: boolean;
  /** The pre-injection capture's stamp (to = from + 2 s); precheck runs 3 s after it. */
  readonly pre: number;
  /** The EMF line times (counters: one). */
  readonly emf: readonly number[];
  readonly started: number;
  readonly stopped: number | null;
  /** The alarm's StateUpdates (absent: none yet). */
  readonly history: ReadonlyArray<{ readonly at: number; readonly to: string; readonly from?: string }>;
  /** The post-injection captures' stamp. */
  readonly post: number;
}

const T = (hhmmss: string) => at(`2026-10-02T${hhmmss}Z`);
/** The suppression-overlap test's window (p1, p2) and the suppressors' turn to ALARM. */
export const WINDOW = { opened_at: T("02:00:00"), expires_at: T("02:45:00") };
export const SUPPRESSORS_ALARM_AT = T("02:01:10");
export const ROUTING = { primary_pool: "p1", routing_version: 5 };

export const SCRIPTS: Readonly<Record<RestoreCase, CaseScript>> = {
  r1: { c: "r1", pool: "p1", overlap: true, pre: T("02:05:00"), emf: [T("02:05:45")], started: T("02:05:40"), stopped: T("02:05:50"), history: [{ at: T("01:00:00"), to: "OK", from: "INSUFFICIENT_DATA" }, { at: T("02:07:10"), to: "ALARM" }, { at: T("02:09:10"), to: "OK", from: "ALARM" }], post: T("02:12:00") },
  a4g: { c: "a4g", pool: "p1", overlap: false, pre: T("02:15:00"), emf: [T("02:15:45")], started: T("02:15:40"), stopped: T("02:15:50"), history: [{ at: T("02:17:00"), to: "ALARM" }], post: T("02:20:00") },
  a4i: { c: "a4i", pool: "p2", overlap: false, pre: T("02:22:00"), emf: [T("02:22:45")], started: T("02:22:40"), stopped: T("02:22:50"), history: [{ at: T("02:24:00"), to: "ALARM" }], post: T("02:26:00") },
  r2: { c: "r2", pool: "p1", overlap: false, pre: T("02:28:00"), emf: [T("02:28:45")], started: T("02:28:40"), stopped: T("02:28:50"), history: [{ at: T("02:30:00"), to: "ALARM" }], post: T("02:33:00") },
  /* R3 on the non-primary pool: a sixty-minute hold, firing just after the contract's 60 periods. */
  r3: { c: "r3", pool: "p2", overlap: false, pre: T("00:50:00"), emf: [T("00:51:00"), T("00:51:15"), T("00:51:30")], started: T("00:50:50"), stopped: null, history: [{ at: T("01:51:30"), to: "ALARM" }], post: T("01:55:00") },
};

export interface CaseBend {
  readonly preStates?: Record<string, string>;
  readonly postAlarms?: Record<string, unknown>;
  readonly history?: Record<string, unknown>;
  readonly supHistory?: Record<string, unknown>;
  readonly task?: Record<string, unknown>;
  readonly log?: Record<string, unknown>;
  readonly logStream?: Record<string, unknown>;
  readonly skip?: readonly string[];
}

/** Write one case's captures (pre, precheck -- through the producer's own precheck -- task, log, post). */
export function writeCase(dir: string, script: CaseScript, bend: CaseBend = {}, run: string = RUN): { readonly precheck: ReturnType<typeof precheckRestoreCase> } {
  const c = script.c;
  const name = alarmName(c, script.pool);
  const preStates = { [name]: "OK", ...(script.overlap ? { [suppressor("p1")]: "ALARM", [suppressor("p2")]: "ALARM" } : {}), ...(bend.preStates ?? {}) };
  write(dir, RESTORE_ALARM_FILES.raw(c, "pre-alarms"), alarmsDoc(preStates));
  write(dir, RESTORE_ALARM_FILES.raw(c, "pre-stamp"), { captured_from: script.pre, captured_to: script.pre + 2000 });
  const precheck = precheckRestoreCase({ dir, run, environment: ENV, pools: [...POOLS] }, { case: c, pool: script.pool, overlap: script.overlap, now: script.pre + 5000 });
  const task = { ...restoreProbeTask(c, script.pool, { started: script.started, stopped: script.stopped }, {}, run), ...(bend.task ?? {}) };
  const files: Record<string, unknown> = {
    [RESTORE_ALARM_FILES.task(c)]: { tasks: [task], failures: [] },
    [RESTORE_ALARM_FILES.logStream(c)]: bend.logStream ?? { log_group: `/gs/${ENV}/game-server`, log_stream: `gs/game-server/${String(task.taskArn).split("/").pop()}` },
    [RESTORE_ALARM_FILES.log(c)]: bend.log ?? { events: [{ message: `L6-6-RESTORE-ALARM-PROBE {"case":"${c}"}` }, ...script.emf.map((t) => ({ message: emfLine(c, script.pool, t) }))] },
    [RESTORE_ALARM_FILES.raw(c, "alarms")]: bend.postAlarms ?? alarmsDoc({ [suppressor("p1")]: script.overlap ? "ALARM" : "OK", [suppressor("p2")]: script.overlap ? "ALARM" : "OK" }),
    [RESTORE_ALARM_FILES.raw(c, "history")]: bend.history ?? historyDoc(name, script.history),
    [RESTORE_ALARM_FILES.raw(c, "stamp")]: { captured_from: script.post, captured_to: script.post + 3000 },
    ...(script.overlap ? { [RESTORE_ALARM_FILES.raw(c, "suppressor-history")]: bend.supHistory ?? Object.fromEntries(POOLS.map((p) => [p, historyDoc(suppressor(p), [{ at: SUPPRESSORS_ALARM_AT, to: "ALARM" }])])) } : {}),
  };
  for (const [file, value] of Object.entries(files)) if (!(bend.skip ?? []).includes(file)) write(dir, file, value);
  return { precheck };
}

export function suppressionRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: SUPPRESSION_OVERLAP_FORMAT,
    kind: SUPPRESSION_OVERLAP_KIND,
    statement: SUPPRESSION_OVERLAP_STATEMENT,
    environment: ENV,
    pools: ["p1", "p2"],
    note: "l6-6 restore drill overlap",
    opened_at: WINDOW.opened_at,
    expires_at: WINDOW.expires_at,
    routing_before: ROUTING,
    open: { outcome: "published", datums: 90, until: WINDOW.expires_at, detail: null },
    closed: { at: T("02:40:00"), outcome: "published", routing_after: ROUTING, detail: null },
    ...over,
  };
}

/**
 * A whole restore-alarm drill in `dir`: the suppression-overlap test's record (open while r1 is prechecked, closed after),
 * every case's captures, each staged by the producer; `record: true` also writes probe-restore-alarms.json.
 */
export function restoreAlarmDrill(dir: string, options: { readonly bends?: Partial<Record<RestoreCase, CaseBend>>; readonly record?: boolean; readonly suppression?: Record<string, unknown>; readonly run?: string; readonly r3Pool?: string } = {}): { readonly staged: Record<string, ReturnType<typeof stageRestoreCase>>; readonly recorded: ReturnType<typeof recordRestoreAlarms> | null } {
  const run = options.run ?? RUN;
  write(dir, RESTORE_ALARM_FILES.suppression, suppressionRecord({ closed: null }));
  const staged: Record<string, ReturnType<typeof stageRestoreCase>> = {};
  for (const c of RESTORE_CASES) {
    const script = c === "r3" && options.r3Pool !== undefined ? { ...SCRIPTS.r3, pool: options.r3Pool } : SCRIPTS[c];
    const w = writeCase(dir, script, options.bends?.[c] ?? {}, run);
    if (w.precheck.kind !== "observed") throw new Error(`precheck ${c}: ${w.precheck.kind} ${w.precheck.reasons.join("; ")}`);
  }
  write(dir, RESTORE_ALARM_FILES.suppression, suppressionRecord(options.suppression ?? {}));
  for (const c of RESTORE_CASES) staged[c] = stageRestoreCase({ dir, run, environment: ENV }, c);
  const recorded = options.record === false ? null : recordRestoreAlarms({ dir, run, environment: ENV, pools: [...POOLS] });
  return { staged, recorded };
}

/* ------------------------------------------------------------------ */
/* The fencing probe tasks                                               */
/* ------------------------------------------------------------------ */

export const ADOPTION = { restore_id: "drill-1002", previous_generation: 1, generation: 2, game_table: `gs-${ENV}-game-g2`, adopted_at: T("01:00:00") };
export const FENCE_POOL = "p2";
const fenceArgs = (mode: FenceProbeMode) => ({ mode, run: RUN, environment: ENV, pool: FENCE_POOL, previousGeneration: 1, generation: 2, restoreId: ADOPTION.restore_id, oldGameTable: `gs-${ENV}-game-g1` });

/** What the in-task probe prints for `mode` (its own shape; the e2e suite proves the real probe prints exactly this). */
export function fenceProbeRecord(mode: FenceProbeMode, taskArn: string, observed = T("01:20:00"), over: Record<string, unknown> = {}): Record<string, unknown> {
  const cases: Record<string, unknown> =
    mode === "ledger-kms"
      ? {
          "old-generation-ledger-write-refused": {
            observed_at: isoOf(observed),
            generation: 1,
            outcome: "fenced",
            fence: "generation",
            detail: "a ledger write of generation 1 was refused by APPGEN's ConditionCheck (APPGEN is 2)",
            evidence: { fence_term: "ConditionCheck APPGEN: schema = 1 AND current_generation = 1", old: { codes: ["ConditionalCheckFailed", "ConditionalCheckFailed"], outcome: "cancelled" }, control: { generation: 2, codes: ["None", "ConditionalCheckFailed"], outcome: "cancelled" }, appgen_before: 2, appgen_after: 2, disposable_key: `L6CERT#${RUN}/RESTORE-FENCE`, written: false },
          },
          "kms-side-effect-withheld": {
            observed_at: isoOf(observed + 1000),
            generation: 1,
            kms_sign_calls: 0,
            outcome: "withheld",
            detail: "the KMS gate withheld a Sign of generation 1 before KMS: the adopted generation is 2, not this task's 1",
            evidence: { gate: "generation", gate_detail: "the adopted generation is 2, not this task's 1", withheld_counter: 1, signs_counter: 0, error_code: "unavailable", native: "PoolWriterNotCurrent", signature_may_exist: false },
          },
        }
      : {
          "old-generation-task-never-ready": {
            observed_at: isoOf(observed),
            generation: 1,
            game_table: `gs-${ENV}-game-g1`,
            ready: false,
            exit_code: 2,
            reason: "generation",
            detail: "the production startup, configured for generation 1, refused before the pool (exit 2)",
            evidence: { startup_error: "AwsStartupError", refusal: "generation", metrics: { StartupRefused: 1, StartupRefusedGeneration: 1 }, boundary_calls: [], runtime_started: false, startup_lines: 1 },
          },
        };
  return { format: RESTORE_FENCE_PROBE_FORMAT, mode, run_id: RUN, environment: ENV, pool: FENCE_POOL, build_id: "2026-10-02-test", started_at: isoOf(observed - 5000), task_arn: taskArn, runtime_parameter: `arn:aws:ssm:us-east-1:111111111111:parameter/gs/${ENV}/runtime/${FENCE_POOL}`, adoption: ADOPTION, refused: null, cases, finished_at: isoOf(observed + 2000), ...over };
}

export function fenceTask(mode: FenceProbeMode, times: { readonly started: number; readonly stopped: number }, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskArn: taskArnOf(mode === "ledger-kms" ? "f1f1" : "f2f2"),
    taskDefinitionArn: TD(FENCE_POOL),
    group: `family:gs-${ENV}-${FENCE_POOL}`,
    startedBy: fenceProbeStartedBy(mode),
    lastStatus: "STOPPED",
    createdAt: cli(times.started - 30_000),
    startedAt: cli(times.started),
    stoppedAt: cli(times.stopped),
    containers: [{ name: "game-server", exitCode: mode === "ledger-kms" ? 0 : 2, imageDigest: `sha256:${"cd".repeat(32)}` }],
    overrides: { containerOverrides: [{ name: "game-server", command: fenceProbeCommand(fenceArgs(mode)), environment: [{ name: "GS_STORAGE", value: CERTIFIER_STORAGE_OVERRIDE }] }] },
    ...extra,
  };
}

/** Both probe tasks' captures (ECS + their logs). */
export function writeFenceProbes(dir: string, bend: Partial<Record<FenceProbeMode, { readonly task?: Record<string, unknown>; readonly record?: Record<string, unknown>; readonly lines?: readonly string[] }>> = {}): void {
  for (const mode of ["ledger-kms", "old-task"] as const) {
    const task = { ...fenceTask(mode, { started: T("01:19:30"), stopped: T("01:20:10") }), ...(bend[mode]?.task ?? {}) };
    const record = { ...fenceProbeRecord(mode, String(task.taskArn)), ...(bend[mode]?.record ?? {}) };
    write(dir, RESTORE_FENCE_FILES.task(mode), { tasks: [task], failures: [] });
    write(dir, RESTORE_FENCE_FILES.logStream(mode), { log_group: `/gs/${ENV}/game-server`, log_stream: `gs/game-server/${String(task.taskArn).split("/").pop()}` });
    write(dir, RESTORE_FENCE_FILES.log(mode), { events: (bend[mode]?.lines ?? ["restore fence probe starting", fenceProbeLine(record)]).map((message, i) => ({ timestamp: i, message })) });
  }
}

export const RUNTIME_ARN = (pool: string) => `arn:aws:ssm:us-east-1:111111111111:parameter/gs/${ENV}/runtime/${pool}`;
export const PRIMARY_TASK = taskArnOf("0aaa1111bbbb2222cccc3333dddd4444");

/** The deployment's capture after the switch (the primary p1 serving generation 2), and the restore-stop stamp. */
export function writeDeploymentCapture(dir: string, bend: { readonly started?: number; readonly health?: string; readonly runtimeParameter?: string; readonly storage?: string; readonly capturedAt?: number; readonly stop?: Record<string, unknown> } = {}): void {
  const td = TD("p1");
  write(dir, "services.json", { services: [{ serviceName: `gs-${ENV}-p1`, status: "ACTIVE", taskDefinition: td, desiredCount: 1, runningCount: 1, pendingCount: 0, deployments: [{ rolloutState: "COMPLETED", taskDefinition: td }] }], failures: [] });
  write(dir, "running-tasks.json", {
    tasks: [{ taskArn: PRIMARY_TASK, group: `service:gs-${ENV}-p1`, lastStatus: "RUNNING", desiredStatus: "RUNNING", taskDefinitionArn: td, startedAt: cli(bend.started ?? T("01:10:00")), attachments: [{ type: "ElasticNetworkInterface", details: [{ name: "privateIPv4Address", value: "10.0.1.23" }] }], containers: [{ name: "game-server", lastStatus: "RUNNING" }] }],
    failures: [],
  });
  write(dir, "target-health.json", { TargetHealthDescriptions: [{ Target: { Id: "10.0.1.23", Port: 8917 }, TargetHealth: { State: bend.health ?? "healthy" } }] });
  write(dir, "task-definition-p1.json", { taskDefinition: { taskDefinitionArn: td, containerDefinitions: [{ name: "game-server", environment: [{ name: "GS_AWS_CONFIG_PARAMETER", value: bend.runtimeParameter ?? RUNTIME_ARN("p1") }, { name: "GS_STORAGE", value: bend.storage ?? "aws" }, { name: "BUILD_ID", value: "2026-10-02-test" }] }] } });
  write(dir, "capture.json", { format: "18COSMOS/L5-8-CAPTURE/v1", captured_at: isoOf(bend.capturedAt ?? T("02:50:00")) });
  write(dir, "restore-stop/stamp.json", { format: "18COSMOS/L6-6-RESTORE-STOP/v2", run_id: RUN, restore_id: ADOPTION.restore_id, captured_at: isoOf(T("00:40:00")), ...(bend.stop ?? {}) });
}
