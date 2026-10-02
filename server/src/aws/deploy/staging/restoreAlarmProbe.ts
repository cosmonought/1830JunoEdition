// server/src/aws/deploy/staging/restoreAlarmProbe.ts
//
// ==================================================================
//  LIVE-6 L6-6 (RESTORE DRILL): THE RESTORE ALARMS' ALARM-PIPELINE INJECTION -- THE PROBE PROGRAM, ITS OVERRIDES, AND THE
//  ONE DERIVATION OF EACH CASE FROM WHAT AWS ANSWERED (shared by the producer and the judge)
// ==================================================================
//
// WHAT THIS IS, AND WHAT IT IS NOT. The restore drill must show R1 (GenerationLost), A4g (StartupRefusedGeneration), A4i
// (StartupRefusedIdentityRestore), R2 (MoneyHeldJournalAhead) and R3 (RestoreUnverifiedGames) each FIRE, with their actions
// never suppressed. Their real causes cannot be produced safely (R1 needs APPGEN to move under a SERVING task, which the
// stop-first restore forbids; R2 a journal-ahead money game; A4i an identity table mid-replay). Owner decision: an
// ALARM-PIPELINE INJECTION is acceptable, and is called exactly that -- it proves the real observability chain
//
//     a standalone ECS probe task -> the PRODUCTION runtimeMetrics EMF encoder (`createEmfSink`, and the decision's own
//     metric set: `taskLostMetrics` / `startupRefusedMetrics` / `moneyHeldJournalAheadMetrics` / `restoreUnverifiedMetrics`,
//     the very functions `awsRuntime.ts` emits through) -> awslogs -> CloudWatch Logs' EMF extraction -> the CloudWatch
//     metric -> the contract's REAL alarm, unchanged
//
// and it NEVER claims to reproduce a destructive runtime fault: no APPGEN, identity restore state, financial journal or
// game is touched, and every record says `kind: "alarm-pipeline-injection"`.
//
// THE PROBE TASK (the flip alarm drill's safety model, `flipAlarmDrill.ts`): `ecs run-task` of a pool's RUNNING task
// definition, standalone (never a service task), the container's command OVERRIDDEN to `node -e RESTORE_PROBE_PROGRAM` and
// GS_STORAGE overridden to CERTIFIER_STORAGE_OVERRIDE (a value start.ts refuses: a lost command override starts no game
// server). The program requires ONLY the image's compiled `aws/runtime/runtimeMetrics.js`; it opens no store, takes no
// pool, role, routing, generation or game, signs nothing, never touches the escrow, and makes no AWS call at all (its EMF
// lines leave through the task's own log stream). It is bounded by construction:
//   r1 a4g a4i r2   ONE record of the decision's metric set, then exit 0 (an injection, not a loss: never exit 3).
//   r3              RestoreUnverifiedGames = 1 every RA_TICK_MS (15 s) under [Environment, Pool], for RA_HOLD_SECONDS
//                   (3900..5400: R3 is Minimum >= 1 for SIXTY consecutive 1-minute periods -- the production contract is
//                   not shortened, so the hold is a wall-clock hour and more), then exit 0; SIGTERM (`hold-stop`) ends it
//                   at once. An interrupted operator run leaves nothing indefinite: the task stops itself at its bound.
// R3 is injected on a NON-primary pool: only a restored table's PRIMARY emits RestoreUnverifiedGames, and its honest 0 would
// hold the Minimum at 0 (an injection never overrides a serving task's value).
//
// NO TIMING SHORTCUT. The EMF timestamp of every injected line is the task's own clock at the moment of writing
// (`createEmfSink`'s `now: Date.now`). Back-dating datapoints to fill R3's sixty periods at once is NOT used: CloudWatch
// documents neither that an alarm re-evaluates past periods for late data nor how far back, so it could not be proven
// from AWS semantics to exercise the unchanged alarm (the brief's rule: prove it or do not use it).
//
// THE EVIDENCE (`<evidence>/restore-alarms/`, every file an AWS answer or a machine stamp; the scripts
// infra/aws/scripts/run-restore-alarm-probe.{sh,ps1} capture them):
//   <c>-launch.json            `stage-probe restore-alarms precheck` (machine): the case, pool, whether the injection is
//                              to overlap the staging flip-suppression test, and the pre-injection capture it judged.
//   raw-<c>-pre-alarms.json    describe-alarms (prefix gs-<env>-), captured immediately BEFORE run-task, with
//   raw-<c>-pre-stamp.json     its machine stamp {captured_from, captured_to}.
//   <c>-task.json              describe-tasks of the probe task (counters: after it stopped; r3: once running).
//   <c>-log-stream.json, <c>-log.json   the task's own log stream, read from its head.
//   raw-<c>-alarms.json        describe-alarms after the injection (the alarm's action wiring, from AWS).
//   raw-<c>-history.json       describe-alarm-history (StateUpdate) of the case's alarm.
//   raw-<c>-suppressor-history.json   {<pool>: describe-alarm-history} of both overlap pools' suppressors (overlap only).
//   raw-<c>-stamp.json         the machine stamp of those post-injection captures.
// `deriveRestoreCase` turns them into the case's facts or says NOT YET / REFUSED. The producer stages its answer; the
// judge (`drills.ts` judgeRestoreAlarmDrill) derives it AGAIN from the same captures and requires the record to equal it:
// a record a person typed, or one whose captures say otherwise, never passes.

import { ALARM_CONTRACT, suppressorName } from "../../controlPlane/alarmContract";
import { cliTime } from "../../controlPlane/evidence";
import { parseSuppressionOverlap, routingUnchanged, SUPPRESSION_OVERLAP_KIND, type SuppressionOverlapRecord } from "../../controlPlane/suppressionOverlap";
import { arr, CERTIFIER_STORAGE_OVERRIDE, num, obj, readEvidence, readEvidenceText, RUN_ID } from "./evidence";

export const RESTORE_ALARM_DIR = "restore-alarms";
export type RestoreCase = "r1" | "a4g" | "a4i" | "r2" | "r3";
export const RESTORE_CASES: readonly RestoreCase[] = Object.freeze(["r1", "a4g", "a4i", "r2", "r3"]);
/** Each case's contract alarm id (`alarm-contract.json`; `drills.ts` RESTORE_ALARM_CASES, in the same order). */
export const RESTORE_CASE_ALARM = Object.freeze({ r1: "r1-generation-lost", a4g: "a4g-generation-refused", a4i: "a4i-identity-restore-refused", r2: "r2-money-journal-ahead", r3: "r3-restore-unverified" } as const);
export type RestoreAlarmId = (typeof RESTORE_CASE_ALARM)[RestoreCase];

export const RESTORE_ALARM_FILES = Object.freeze({
  suppression: `${RESTORE_ALARM_DIR}/suppression-window.json`,
  launch: (c: RestoreCase) => `${RESTORE_ALARM_DIR}/${c}-launch.json`,
  task: (c: RestoreCase) => `${RESTORE_ALARM_DIR}/${c}-task.json`,
  taskStopped: (c: RestoreCase) => `${RESTORE_ALARM_DIR}/${c}-task-stopped.json`,
  log: (c: RestoreCase) => `${RESTORE_ALARM_DIR}/${c}-log.json`,
  logStream: (c: RestoreCase) => `${RESTORE_ALARM_DIR}/${c}-log-stream.json`,
  raw: (c: RestoreCase, kind: "pre-alarms" | "pre-stamp" | "alarms" | "history" | "suppressor-history" | "stamp") => `${RESTORE_ALARM_DIR}/raw-${c}-${kind}.json`,
  observation: (c: RestoreCase) => `${RESTORE_ALARM_DIR}/observe-${c}.json`,
});

export const RESTORE_LAUNCH_FORMAT = "18COSMOS/L6-6-RESTORE-ALARM-LAUNCH/v1";
export const RESTORE_OBSERVATION_FORMAT = "18COSMOS/L6-6-RESTORE-ALARM-OBSERVATION/v1";
export const INJECTION_KIND = "alarm-pipeline-injection";
export const INJECTION_WHY = "l6-6-restore-alarm-drill";
export const restoreStartedBy = (c: RestoreCase): string => `l6-6-restore-alarm-${c}`;
/** The image's compiled encoder (Dockerfile: WORKDIR /app/server, dist/ copied whole) -- the flip drill's path. */
export const IMAGE_METRICS_MODULE = "/app/server/dist/server/src/aws/runtime/runtimeMetrics.js";
/** R3's hold: more than the contract's 60 one-minute periods plus the EMF/alarm latency, bounded. */
export const R3_HOLD_MIN_SECONDS = 3900;
export const R3_HOLD_DEFAULT_SECONDS = 4500;
export const R3_HOLD_MAX_SECONDS = 5400;
export const TICK_MS = 15_000;
/** A transition is the injection's only within this long after the contract's own earliest firing time. */
export const BINDING_MS = 15 * 60_000;
/** Clocks differ (the operator's machine, the task, ECS): comparisons across them allow this much (`certify.ts`). */
export const SKEW_MS = 120_000;
/** The overlap must leave time for the task to start and write inside the window. */
export const OVERLAP_MARGIN_MS = 5 * 60_000;
export const EXIT_NOT_YET = 10;

const ENV_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const POOL_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;

/* ------------------------------------------------------------------ */
/* The in-task program and its overrides                                */
/* ------------------------------------------------------------------ */

/**
 * The standalone task's whole program (`node -e`). Parameters arrive as environment variables set by the overrides; it
 * validates them, requires the image's runtimeMetrics module (RA_METRICS_MODULE only for the offline tests), refuses an
 * image without the decisions' metric functions, and writes through `createEmfSink`. A marker line
 * `L6-6-RESTORE-ALARM-PROBE {...}` (not JSON, never EMF) says what it did.
 */
export const RESTORE_PROBE_PROGRAM = [
  '"use strict";',
  "const e=process.env,c=e.RA_CASE,env=e.RA_ENVIRONMENT,pool=e.RA_POOL,run=e.RA_RUN;",
  "const say=(o)=>process.stdout.write('L6-6-RESTORE-ALARM-PROBE '+JSON.stringify(Object.assign({run:run,case:c,pool:pool,at:Date.now()},o))+'\\n');",
  "const bad=(why)=>{say({refused:why});process.exit(2);};",
  "if(['r1','a4g','a4i','r2','r3'].indexOf(c)<0)bad('case');",
  "if(!/^[a-z][a-z0-9-]{0,31}$/.test(env||'')||/^prod/.test(env))bad('environment');",
  "if(!/^[a-z][a-z0-9-]{0,15}$/.test(pool||''))bad('pool');",
  "if(!/^[a-z0-9][a-z0-9-]{5,39}$/.test(run||''))bad('run');",
  `const m=require(e.RA_METRICS_MODULE||'${IMAGE_METRICS_MODULE}');`,
  "if(['createEmfSink','taskLostMetrics','startupRefusedMetrics','moneyHeldJournalAheadMetrics','restoreUnverifiedMetrics'].some((f)=>typeof m[f]!=='function'))bad('image-predates-the-decision-metric-sets');",
  "const sink=m.createEmfSink({context:{environment:env,pool:pool},now:Date.now,write:(l)=>process.stdout.write(l+'\\n')});",
  `const why='${INJECTION_WHY}';`,
  "if(c!=='r3'){",
  "const rec=c==='r1'?{event:'task-lost',metrics:m.taskLostMetrics('generation-moved'),properties:{why:why,cause:'generation-moved'}}:c==='r2'?{event:'money-held',metrics:m.moneyHeldJournalAheadMetrics(),properties:{why:why}}:{event:'startup-refused',metrics:m.startupRefusedMetrics(c==='a4g'?'generation':'identity-restore'),properties:{why:why,refusal:c==='a4g'?'generation':'identity-restore'}};",
  "const ok=sink.emit(rec);say({emitted:ok,exit:ok?0:2});setTimeout(()=>process.exit(ok?0:2),3000);",
  "}else{",
  "const max=Number(e.RA_HOLD_SECONDS),tick=Number(e.RA_TICK_MS||'15000');",
  `if(!Number.isSafeInteger(max)||max<1||max>${R3_HOLD_MAX_SECONDS})bad('hold-seconds');`,
  "if(!Number.isSafeInteger(tick)||tick<100||tick>60000)bad('tick');",
  "const end=Date.now()+max*1000;let n=0;",
  "const once=()=>{if(Date.now()>=end){say({done:'max-duration',emitted:n});process.exit(0);}if(sink.emit({event:'task-status',metrics:m.restoreUnverifiedMetrics(1),properties:{why:why}}))n+=1;};",
  "process.on('SIGTERM',()=>{say({done:'stopped',emitted:n});process.exit(0);});",
  "say({holding:'RestoreUnverifiedGames=1',seconds:max});once();setInterval(once,tick);",
  "}",
].join("");

export interface RestoreOverrideInput {
  readonly case: RestoreCase;
  readonly environment: string;
  readonly pool: string;
  readonly run: string;
  readonly holdSeconds?: number;
}

/** `ecs run-task --overrides` for one probe task: the command is the program, never start.ts; GS_STORAGE refuses a server. */
export function restoreProbeOverrides(input: RestoreOverrideInput): Record<string, unknown> {
  if (!RESTORE_CASES.includes(input.case)) throw new Error("--case is r1, a4g, a4i, r2 or r3");
  if (!ENV_PATTERN.test(input.environment) || /^prod/.test(input.environment)) throw new Error("the restore alarm probe runs only in a non-prod environment");
  if (!POOL_PATTERN.test(input.pool)) throw new Error("--pool must be a pool id");
  if (!RUN_ID.test(input.run)) throw new Error("--run-id must be a run id");
  const hold = input.case === "r3" ? (input.holdSeconds ?? R3_HOLD_DEFAULT_SECONDS) : null;
  if (input.case !== "r3" && input.holdSeconds !== undefined) throw new Error("--hold-seconds is for --case r3 only");
  if (hold !== null && (!Number.isSafeInteger(hold) || hold < R3_HOLD_MIN_SECONDS || hold > R3_HOLD_MAX_SECONDS)) throw new Error(`--hold-seconds is ${R3_HOLD_MIN_SECONDS}..${R3_HOLD_MAX_SECONDS} (R3 needs 60 consecutive one-minute periods plus the pipeline's latency; bounded)`);
  const environment = [
    { name: "GS_STORAGE", value: CERTIFIER_STORAGE_OVERRIDE },
    { name: "RA_CASE", value: input.case },
    { name: "RA_ENVIRONMENT", value: input.environment },
    { name: "RA_POOL", value: input.pool },
    { name: "RA_RUN", value: input.run },
    ...(hold === null ? [] : [{ name: "RA_HOLD_SECONDS", value: String(hold) }, { name: "RA_TICK_MS", value: String(TICK_MS) }]),
  ];
  return { containerOverrides: [{ name: "game-server", command: ["node", "-e", RESTORE_PROBE_PROGRAM], environment }] };
}

/* ------------------------------------------------------------------ */
/* The contract                                                         */
/* ------------------------------------------------------------------ */

const specOf = (c: RestoreCase) => {
  const spec = ALARM_CONTRACT.alarms.find((a) => a.id === RESTORE_CASE_ALARM[c]);
  if (spec === undefined) throw new Error(`the alarm contract has no ${RESTORE_CASE_ALARM[c]}`);
  return spec;
};
/** The case's alarm name in this environment (R3 is per pool). */
export const restoreAlarmName = (environment: string, c: RestoreCase, pool: string): string => (specOf(c).scope === "pool" ? `gs-${environment}-${pool}-${RESTORE_CASE_ALARM[c]}` : `gs-${environment}-${RESTORE_CASE_ALARM[c]}`);
/** The case's metric (the contract's one metric of that alarm). */
export const restoreMetricOf = (c: RestoreCase): string => String(specOf(c).metrics[0].metric);
/** The earliest the contract lets the alarm fire after the first injected datapoint: (datapoints - 1) periods (R3: 59 min). */
export const contractMinDelayMs = (c: RestoreCase): number => (Number(specOf(c).datapoints_to_alarm) - 1) * Number(specOf(c).period) * 1000;
const dimensionsOf = (c: RestoreCase): readonly string[] => (ALARM_CONTRACT.dimensions as Record<string, readonly string[]>)[specOf(c).scope];

/* ------------------------------------------------------------------ */
/* Reading what the scripts captured                                    */
/* ------------------------------------------------------------------ */

export type Verdict<T> = { readonly kind: "observed"; readonly value: T } | { readonly kind: "not-yet"; readonly reasons: readonly string[] } | { readonly kind: "refused"; readonly reasons: readonly string[] };
export const refused = <T>(...reasons: string[]): Verdict<T> => ({ kind: "refused", reasons });
export const notYet = <T>(...reasons: string[]): Verdict<T> => ({ kind: "not-yet", reasons });

export interface RestoreAlarmContext {
  readonly dir: string;
  readonly run: string;
  readonly environment: string;
}

const iso = (ms: number): string => (Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms));

/** A capture's machine stamp {captured_from, captured_to} (ms). */
export function stampOf(dir: string, file: string): { readonly from: number; readonly to: number } | { readonly problem: string } {
  const r = readEvidence(dir, file);
  if (!r.ok) return { problem: r.problem };
  const from = num(obj(r.value).captured_from);
  const to = num(obj(r.value).captured_to);
  if (from === null || to === null || to < from) return { problem: `${file}: captured_from / captured_to are not an interval` };
  return { from, to };
}

const metricAlarms = (alarms: unknown) => new Map(arr(obj(alarms).MetricAlarms).map(obj).map((a) => [String(a.AlarmName), a]));
const compositeAlarms = (alarms: unknown) => arr(obj(alarms).CompositeAlarms).map(obj);

export interface StateUpdate {
  readonly at: number;
  readonly from: string;
  readonly to: string;
}

/** An alarm's StateUpdate history (oldest first), or why it is not a complete answer. */
export function stateUpdates(doc: unknown, alarm: string): { readonly updates: StateUpdate[] } | { readonly problem: string } {
  const d = obj(doc);
  if (!Array.isArray(d.AlarmHistoryItems)) return { problem: "not a describe-alarm-history answer" };
  if (typeof d.NextToken === "string" && d.NextToken !== "") return { problem: "the history answer is one page of several (NextToken): read it completely" };
  const updates: StateUpdate[] = [];
  for (const item of d.AlarmHistoryItems.map(obj)) {
    if (item.AlarmName !== alarm || item.HistoryItemType !== "StateUpdate") continue;
    let data: Record<string, unknown> = {};
    try {
      data = obj(JSON.parse(String(item.HistoryData ?? "{}")));
    } catch {
      return { problem: `a ${alarm} history item's HistoryData is not JSON` };
    }
    const at = cliTime(item.Timestamp as never);
    if (at === null) return { problem: `a ${alarm} history item has no time` };
    updates.push({ at, from: String(obj(data.oldState).stateValue ?? ""), to: String(obj(data.newState).stateValue ?? "") });
  }
  return { updates: updates.sort((a, b) => a.at - b.at) };
}

interface ProbeTaskFacts {
  readonly taskArn: string;
  readonly taskDefinitionArn: string;
  readonly lastStatus: string;
  readonly startedAt: number | null;
  readonly stoppedAt: number | null;
  readonly exitCode: number | null;
  readonly imageDigest: string | null;
}

const envOf = (container: Record<string, unknown>, name: string): string | undefined => arr(container.environment).map(obj).find((v) => v.name === name)?.value as string | undefined;

/** One probe task from a `describe-tasks` capture: exactly one, started by this case's drill, running THE program. */
export function restoreProbeTaskOf(capture: unknown, c: RestoreCase, expect: { readonly environment: string; readonly pool: string; readonly run: string }): { readonly task: ProbeTaskFacts } | { readonly problem: string } {
  const tasks = arr(obj(capture).tasks).map(obj);
  if (tasks.length !== 1) return { problem: `expected exactly one ${c} probe task in the capture, found ${tasks.length}` };
  const t = tasks[0];
  if (t.startedBy !== restoreStartedBy(c)) return { problem: `the task was started by ${String(t.startedBy)}, not ${restoreStartedBy(c)}` };
  if (typeof t.group === "string" && t.group.startsWith("service:")) return { problem: "the task belongs to a service: a probe task is always standalone" };
  const override = arr(obj(t.overrides).containerOverrides).map(obj).find((x) => x.name === "game-server");
  const command = arr(override?.command);
  if (override === undefined || command.length !== 3 || command[0] !== "node" || command[1] !== "-e" || command[2] !== RESTORE_PROBE_PROGRAM) return { problem: "the task does not run the drill's program (its command override is not this build's RESTORE_PROBE_PROGRAM)" };
  if (envOf(override, "GS_STORAGE") !== CERTIFIER_STORAGE_OVERRIDE) return { problem: `GS_STORAGE is not ${CERTIFIER_STORAGE_OVERRIDE}: refused (a lost override must start nothing)` };
  const got = [envOf(override, "RA_CASE"), envOf(override, "RA_ENVIRONMENT"), envOf(override, "RA_POOL"), envOf(override, "RA_RUN")];
  if (got[0] !== c || got[1] !== expect.environment || got[2] !== expect.pool || got[3] !== expect.run) return { problem: `the task is case ${String(got[0])} in ${String(got[1])} on ${String(got[2])} for run ${String(got[3])}, not ${c} in ${expect.environment} on ${expect.pool} for ${expect.run}` };
  const container = arr(t.containers).map(obj).find((x) => x.name === "game-server") ?? {};
  return {
    task: {
      taskArn: String(t.taskArn ?? ""),
      taskDefinitionArn: String(t.taskDefinitionArn ?? ""),
      lastStatus: String(t.lastStatus ?? ""),
      startedAt: cliTime(t.startedAt as never),
      stoppedAt: cliTime(t.stoppedAt as never),
      exitCode: num(container.exitCode),
      imageDigest: typeof container.imageDigest === "string" ? container.imageDigest : null,
    },
  };
}

/** The launch record `precheck` wrote (the case's pool and whether it overlaps the suppression test). */
export interface LaunchRecord {
  readonly format: typeof RESTORE_LAUNCH_FORMAT;
  readonly run_id: string;
  readonly environment: string;
  readonly case: RestoreCase;
  readonly alarm: string;
  readonly pool: string;
  readonly overlap: boolean;
  readonly prechecked_at: number;
  readonly pre: { readonly captured_from: number; readonly captured_to: number; readonly alarm_state: string; readonly suppressors: Readonly<Record<string, string>> | null };
}

function launchOf(ctx: RestoreAlarmContext, c: RestoreCase): LaunchRecord | { readonly problem: string } {
  const r = readEvidence(ctx.dir, RESTORE_ALARM_FILES.launch(c), { ownRecord: true });
  if (!r.ok) return { problem: `${r.problem} (stage-probe restore-alarms precheck writes it before the probe task is started)` };
  const l = obj(r.value);
  const pre = obj(l.pre);
  if (l.format !== RESTORE_LAUNCH_FORMAT || l.run_id !== ctx.run || l.environment !== ctx.environment || l.case !== c || typeof l.pool !== "string" || typeof l.overlap !== "boolean" || typeof l.alarm !== "string" || num(l.prechecked_at) === null || num(pre.captured_to) === null) {
    return { problem: `${RESTORE_ALARM_FILES.launch(c)} is not this run's ${c} launch` };
  }
  return l as unknown as LaunchRecord;
}

/** The staging flip-suppression overlap test's record, if one exists (`gamesDoctor aws suppression-overlap`). */
export function suppressionRecordOf(dir: string): SuppressionOverlapRecord | { readonly problem: string } {
  const r = readEvidenceText(dir, RESTORE_ALARM_FILES.suppression);
  if (!r.ok) return { problem: `${r.problem} (gamesDoctor aws suppression-overlap open ... --record <dir>/${RESTORE_ALARM_FILES.suppression})` };
  return parseSuppressionOverlap(r.text);
}

/* ------------------------------------------------------------------ */
/* The case, from AWS                                                   */
/* ------------------------------------------------------------------ */

export interface SuppressorProof {
  readonly pool: string;
  readonly alarm: string;
  /** The suppressor's state in the pre-injection describe-alarms (captured before run-task). */
  readonly pre_state: "ALARM";
  readonly pre_at: number;
  /** Its last StateUpdate at or before the injection (describe-alarm-history read after it): to ALARM. */
  readonly history_alarm_at: number;
  readonly state_at_injection: "ALARM";
}

export interface SuppressionOverlapFacts {
  readonly kind: typeof SUPPRESSION_OVERLAP_KIND;
  readonly pools: readonly [string, string];
  readonly opened_at: number;
  readonly expires_at: number;
  readonly routing_before: { readonly primary_pool: string; readonly routing_version: number };
  readonly suppressors: readonly SuppressorProof[];
}

export interface RestoreCaseFacts {
  readonly alarm: string;
  readonly injected_at: number;
  readonly alarm_at: number;
  readonly state: "ALARM";
  readonly actions_suppressed: false;
  /** The pre-strengthening field: a self-reported window is never evidence -- always null here. */
  readonly overlapping_flip_window: null;
  readonly pre_injection: { readonly at: number; readonly state: string };
  readonly injection: {
    readonly kind: typeof INJECTION_KIND;
    readonly case: RestoreCase;
    readonly pool: string;
    readonly task_arn: string;
    readonly task_definition: string;
    readonly image_digest: string | null;
    readonly started_at: number | null;
    readonly stopped_at: number | null;
    readonly exit_code: number | null;
    readonly log_group: string;
    readonly log_stream: string;
    readonly namespace: string;
    readonly dimensions: readonly string[];
    readonly metric: string;
    readonly value: number;
    readonly emf_records: number;
    readonly metrics: readonly string[];
  };
  readonly history_read_at: number;
  readonly suppression_overlap: SuppressionOverlapFacts | null;
}

/**
 * Derive one case from the captures (see the header). OBSERVED: every fact holds. NOT YET: the alarm has not fired yet
 * within its binding (the script polls). REFUSED: something can no longer become true, or is not this drill's.
 */
export function deriveRestoreCase(ctx: RestoreAlarmContext, c: RestoreCase): Verdict<RestoreCaseFacts> {
  if (/^prod/.test(ctx.environment)) return refused("the restore alarm drill never runs in a prod* environment");
  const launch = launchOf(ctx, c);
  if ("problem" in launch) return refused(launch.problem);
  const alarm = restoreAlarmName(ctx.environment, c, launch.pool);
  if (launch.alarm !== alarm) return refused(`the launch names ${launch.alarm}, not ${alarm}`);
  const spec = specOf(c);
  if (spec.suppressible !== false) return refused(`${spec.id} is suppressible in the alarm contract: a restore alarm never is`);

  /* 1. The probe task: this case's standalone program, finished cleanly (r3: running its hold, or finished cleanly). */
  const cap = readEvidence(ctx.dir, RESTORE_ALARM_FILES.task(c));
  if (!cap.ok) return refused(`${cap.problem} (run-restore-alarm-probe ${c === "r3" ? "hold-start" : "inject"} records it)`);
  const got = restoreProbeTaskOf(cap.value, c, { environment: ctx.environment, pool: launch.pool, run: ctx.run });
  if ("problem" in got) return refused(got.problem);
  const stopped = c === "r3" ? readEvidence(ctx.dir, RESTORE_ALARM_FILES.taskStopped(c)) : null;
  const final = stopped !== null && stopped.ok ? restoreProbeTaskOf(stopped.value, c, { environment: ctx.environment, pool: launch.pool, run: ctx.run }) : null;
  if (final !== null && "problem" in final) return refused(`${RESTORE_ALARM_FILES.taskStopped(c)}: ${final.problem}`);
  const task = final !== null && "task" in final && final.task.taskArn === got.task.taskArn ? final.task : got.task;
  if (final !== null && "task" in final && final.task.taskArn !== got.task.taskArn) return refused(`${RESTORE_ALARM_FILES.taskStopped(c)} is another task's`);
  if (c !== "r3" && (task.lastStatus !== "STOPPED" || task.exitCode !== 0)) return refused(`the ${c} probe task is ${task.lastStatus}, exit ${String(task.exitCode)}: an injection task stops cleanly with exit 0 (it is never a real loss)`);
  if (c === "r3" && task.lastStatus === "STOPPED" && task.exitCode !== 0) return refused(`the r3 hold task stopped with exit ${String(task.exitCode)}, not 0`);
  if (task.startedAt === null) return refused(`the ${c} probe task has no start time`);

  /* 2. Its own log: the decision's EMF record(s), through the production encoder, under the alarm's dimensions. */
  const where = readEvidence(ctx.dir, RESTORE_ALARM_FILES.logStream(c));
  if (!where.ok) return refused(where.problem);
  const logGroup = String(obj(where.value).log_group ?? "");
  const logStream = String(obj(where.value).log_stream ?? "");
  if (!logStream.endsWith(`/${task.taskArn.split("/").pop()}`) || logGroup === "") return refused(`the captured log stream ${logStream} is not the ${c} probe task's`);
  const log = readEvidence(ctx.dir, RESTORE_ALARM_FILES.log(c));
  if (!log.ok) return refused(log.problem);
  const emf = arr(obj(log.value).events)
    .map((e) => String(obj(e).message ?? ""))
    .flatMap((m) => {
      try {
        const j = obj(JSON.parse(m));
        return j._aws !== undefined ? [j] : [];
      } catch {
        return [];
      }
    });
  const metric = restoreMetricOf(c);
  const dims = dimensionsOf(c);
  const ours = emf.filter((j) => j.Environment === ctx.environment && j.Pool === launch.pool && typeof j[metric] === "number" && (j[metric] as number) >= Number(spec.threshold));
  if (ours.length === 0) return c === "r3" ? notYet(`no ${metric} record in the r3 task's log yet`) : refused(`the ${c} task's log holds no EMF record of ${metric} >= ${String(spec.threshold)} for ${ctx.environment}/${launch.pool} (the metric never left the task)`);
  if (c !== "r3" && (emf.length !== 1 || ours.length !== 1)) return refused(`the ${c} task's log holds ${emf.length} EMF records (${ours.length} of ${metric}): one injection is exactly one record`);
  if (c === "r3" && emf.some((j) => Object.keys(j).some((k) => /^[A-Z]/.test(k) && !["Environment", "Pool", metric].includes(k)))) return refused("the r3 task's log carries a metric other than RestoreUnverifiedGames");
  for (const j of ours) {
    const directives = arr(obj(j._aws).CloudWatchMetrics).map(obj);
    const carries = directives.some((d) => d.Namespace === ALARM_CONTRACT.namespace && arr(d.Dimensions).some((ds) => JSON.stringify(ds) === JSON.stringify(dims)) && arr(d.Metrics).some((m) => obj(m).Name === metric));
    if (!carries) return refused(`an EMF record of ${metric} is not under ${ALARM_CONTRACT.namespace} with the alarm's dimensions [${dims.join(", ")}]`);
    if (j.why !== INJECTION_WHY) return refused(`an EMF record of ${metric} is not marked ${INJECTION_WHY}`);
  }
  const times = ours.map((j) => num(obj(j._aws).Timestamp)).filter((t): t is number => t !== null);
  if (times.length !== ours.length) return refused(`an EMF record of ${metric} has no timestamp`);
  const injectedAt = Math.min(...times);
  if (injectedAt < task.startedAt - SKEW_MS || (task.stoppedAt !== null && injectedAt > task.stoppedAt + SKEW_MS)) return refused(`the EMF record's time ${iso(injectedAt)} is outside the task's life (${iso(task.startedAt)}..${task.stoppedAt === null ? "running" : iso(task.stoppedAt)})`);

  /* 3. Before the injection: the alarm was NOT in ALARM (an injection binds only a transition it caused). */
  const preStamp = stampOf(ctx.dir, RESTORE_ALARM_FILES.raw(c, "pre-stamp"));
  if ("problem" in preStamp) return refused(preStamp.problem);
  const pre = readEvidence(ctx.dir, RESTORE_ALARM_FILES.raw(c, "pre-alarms"));
  if (!pre.ok) return refused(pre.problem);
  const preAlarm = metricAlarms(pre.value).get(alarm);
  if (preAlarm === undefined) return refused(`${alarm} is not in the pre-injection describe-alarms (never invented)`);
  if (preStamp.to > injectedAt + SKEW_MS) return refused(`the pre-injection capture (${iso(preStamp.to)}) is not before the injection (${iso(injectedAt)})`);
  if (String(preAlarm.StateValue) === "ALARM") return refused(`${alarm} was already ALARM before the injection: no transition can be bound to it`);

  /* 4. After: the alarm's actions are not suppressed -- enabled, and wrapped by no composite with an actions suppressor. */
  const stamp = stampOf(ctx.dir, RESTORE_ALARM_FILES.raw(c, "stamp"));
  if ("problem" in stamp) return refused(stamp.problem);
  if (stamp.from < injectedAt) return notYet(`the post-injection captures (${iso(stamp.from)}) precede the injection (${iso(injectedAt)}): capture again`);
  const post = readEvidence(ctx.dir, RESTORE_ALARM_FILES.raw(c, "alarms"));
  if (!post.ok) return refused(post.problem);
  const now = metricAlarms(post.value).get(alarm);
  if (now === undefined) return refused(`${alarm} is not in describe-alarms (never invented)`);
  const wrapped = compositeAlarms(post.value).some((x) => typeof x.ActionsSuppressor === "string" && x.ActionsSuppressor !== "" && String(x.AlarmRule ?? "").includes(`"${alarm}"`));
  if (now.ActionsEnabled !== true || wrapped) return refused(`${alarm} actions are suppressed (ActionsEnabled ${String(now.ActionsEnabled)}${wrapped ? ", wrapped by a composite with an actions suppressor" : ""}): a restore alarm never is`);

  /* 5. The transition: to ALARM at/after the contract's earliest firing time for this injection, within the binding. */
  const history = readEvidence(ctx.dir, RESTORE_ALARM_FILES.raw(c, "history"));
  if (!history.ok) return refused(history.problem);
  const read = stateUpdates(history.value, alarm);
  if ("problem" in read) return refused(read.problem);
  const prior = read.updates.filter((u) => u.at < injectedAt).pop();
  if (prior !== undefined && prior.to === "ALARM") return refused(`${alarm} went to ALARM at ${iso(prior.at)}, before the injection, and had not left it: not this injection's transition`);
  const earliest = injectedAt + contractMinDelayMs(c);
  const fired = read.updates.find((u) => u.at >= injectedAt && u.to === "ALARM");
  if (fired === undefined) {
    if (stamp.from > earliest + BINDING_MS) return refused(`${alarm} did not go to ALARM by ${iso(earliest + BINDING_MS)} (the contract's earliest ${iso(earliest)} + ${BINDING_MS / 60_000} min): the injection is not bound to any transition`);
    return notYet(`no ${alarm} transition to ALARM since the injection yet (earliest by the contract: ${iso(earliest)}; history read, nothing assumed)`);
  }
  if (fired.at < earliest) return refused(`${alarm} went to ALARM at ${iso(fired.at)}, before the contract's ${String(spec.datapoints_to_alarm)} period(s) after the injection could pass (${iso(earliest)}): not this injection's`);
  if (fired.at > earliest + BINDING_MS) return refused(`${alarm} went to ALARM at ${iso(fired.at)}, more than ${BINDING_MS / 60_000} min after the contract's earliest firing for this injection: not bound to it`);

  /* 6. The overlap (when the launch claimed one): the staging flip-suppression test's window covers the injection, and BOTH
        of its pools' suppressors were ALARM at the injection -- from CloudWatch's own answers, never this drill's word. */
  let overlap: SuppressionOverlapFacts | null = null;
  if (launch.overlap) {
    const w = suppressionRecordOf(ctx.dir);
    if ("problem" in w) return refused(`the launch claimed an overlap, but ${RESTORE_ALARM_FILES.suppression}: ${w.problem}`);
    if (w.environment !== ctx.environment) return refused(`the suppression-overlap test is ${w.environment}'s`);
    if (w.open.outcome !== "published") return refused(`the suppression-overlap test's datapoints were not published (${w.open.outcome})`);
    if (!(w.opened_at <= injectedAt && injectedAt < w.expires_at)) return refused(`the injection (${iso(injectedAt)}) is outside the suppression-overlap window ${iso(w.opened_at)}..${iso(w.expires_at)}`);
    const supHistory = readEvidence(ctx.dir, RESTORE_ALARM_FILES.raw(c, "suppressor-history"));
    if (!supHistory.ok) return refused(`${supHistory.problem} (the overlap's suppressor history)`);
    const proofs: SuppressorProof[] = [];
    for (const pool of w.pools) {
      const name = suppressorName(ctx.environment, pool);
      const preSup = metricAlarms(pre.value).get(name);
      if (preSup === undefined) return refused(`${name} is not in the pre-injection describe-alarms: no suppressor of pool ${pool} exists in this environment`);
      if (String(preSup.StateValue) !== "ALARM") return refused(`${name} was ${String(preSup.StateValue)} just before the injection, not ALARM`);
      const supRead = stateUpdates(obj(supHistory.value)[pool], name);
      if ("problem" in supRead) return refused(`${name}: ${supRead.problem}`);
      const last = supRead.updates.filter((u) => u.at <= injectedAt).pop();
      if (last === undefined || last.to !== "ALARM") return refused(`${name}'s last state change at or before the injection is ${last === undefined ? "none" : `to ${last.to} at ${iso(last.at)}`}: it was not ALARM at the injection`);
      if (last.at < Math.floor(w.opened_at / 60_000) * 60_000) return refused(`${name} went to ALARM at ${iso(last.at)}, before this test's window opened (${iso(w.opened_at)}): another window's suppression is not this test's`);
      proofs.push({ pool, alarm: name, pre_state: "ALARM", pre_at: preStamp.to, history_alarm_at: last.at, state_at_injection: "ALARM" });
    }
    overlap = { kind: SUPPRESSION_OVERLAP_KIND, pools: w.pools, opened_at: w.opened_at, expires_at: w.expires_at, routing_before: w.routing_before, suppressors: proofs };
  }

  const first = ours.find((j) => num(obj(j._aws).Timestamp) === injectedAt) as Record<string, unknown>;
  return {
    kind: "observed",
    value: {
      alarm,
      injected_at: injectedAt,
      alarm_at: fired.at,
      state: "ALARM",
      actions_suppressed: false,
      overlapping_flip_window: null,
      pre_injection: { at: preStamp.to, state: String(preAlarm.StateValue) },
      injection: {
        kind: INJECTION_KIND,
        case: c,
        pool: launch.pool,
        task_arn: task.taskArn,
        task_definition: task.taskDefinitionArn,
        image_digest: task.imageDigest,
        started_at: task.startedAt,
        stopped_at: task.stoppedAt,
        exit_code: task.exitCode,
        log_group: logGroup,
        log_stream: logStream,
        namespace: ALARM_CONTRACT.namespace,
        dimensions: [...dims],
        metric,
        value: first[metric] as number,
        emf_records: ours.length,
        metrics: Object.keys(first).filter((k) => /^[A-Z]/.test(k) && k !== "Environment" && k !== "Pool").sort(),
      },
      history_read_at: stamp.from,
      suppression_overlap: overlap,
    },
  };
}

/** For the record and the judge: the overlap test left SYSTEM/ROUTING exactly as it found it (its close read it). */
export function overlapRoutingProblem(dir: string): string | null {
  const w = suppressionRecordOf(dir);
  if ("problem" in w) return w.problem;
  if (w.closed === null) return `the suppression-overlap test was not closed: \`gamesDoctor aws suppression-overlap close --record <dir>/${RESTORE_ALARM_FILES.suppression} --apply\` reads SYSTEM/ROUTING again`;
  if (!routingUnchanged(w)) return `SYSTEM/ROUTING at the close (${JSON.stringify(w.closed.routing_after)}) is not the routing read at the open (${JSON.stringify(w.routing_before)})`;
  return null;
}

export const POOL_ID = POOL_PATTERN;
export const ENVIRONMENT_ID = ENV_PATTERN;
