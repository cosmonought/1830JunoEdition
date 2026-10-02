// server/src/aws/deploy/staging/flipAlarmDrill.ts
//
// ==================================================================
//  LIVE-6 L6-6: THE FLIP DRILL'S ALARM OBSERVATIONS -- A SUPPORTED PRODUCER FOR `probe-flip-alarms.json`
// ==================================================================
//
// `drills.ts` judges `probe-flip-alarms.json` (FLIP_ALARM_DRILL_FORMAT) and nothing in the repository produced it. This
// module is that producer. It changes no judge, no alarm, no threshold and no runtime behaviour; it drives the REAL alarm
// pipeline (a standalone ECS task -> its awslogs stream -> CloudWatch Logs' EMF extraction -> the contract's metric and
// composite alarms -> the flip window's suppressors) and records what CloudWatch then says.
//
// TWO STANDALONE PROBE TASKS (launched by infra/aws/scripts/run-flip-alarm-probe.{ps1,sh}, the run-task-probe safety
// model): `ecs run-task` of the pool's RUNNING task definition with the container's command OVERRIDDEN to a `node -e`
// program (`PROBE_PROGRAM`) and GS_STORAGE overridden to CERTIFIER_STORAGE_OVERRIDE, a value start.ts refuses (exit 2) --
// so even a lost command override starts no server. The program requires ONLY the image's own compiled
// `aws/runtime/runtimeMetrics.js` and writes through its `createEmfSink` (the production encoder: no second copy of the
// EMF schema). It never imports the game server, opens no store, takes no pool, role, routing, generation or game, signs
// nothing and touches no escrow:
//   inject   one `task-lost` record { TaskLost: 1, TaskSuperseded: 0 } (A1's `TaskLost - TaskSuperseded`), then the
//            task exits 3 -- an ALARM-PIPELINE injection, not a pool loss: no serving task is fenced.
//   hold     `PoolWriterConfirmed = 0` for ONE named flip pool every `FA_TICK_MS` (15 s) under [Environment, Pool] --
//            A12b (`Minimum < 1` for two 60 s periods) is driven by the drill's 0 while the serving task keeps reporting
//            its true 1; ownership is untouched. Bounded: it exits 0 after FA_HOLD_SECONDS (<= HOLD_MAX_SECONDS) or on
//            SIGTERM (`hold-stop`).
//
// THE RECORD IS MADE FROM AWS, NEVER TYPED. The scripts capture `describe-tasks`, `describe-alarms` and (for A1)
// `describe-alarm-history` with machine timestamps around each capture; `stage-probe flip-alarms observe --phase
// a1|during|after` validates one phase against the flip record (`flip-record.json`, L6-2's) and stages it; `stage-probe
// flip-alarms record` assembles the three cases, judges the candidate with the UNCHANGED `judgeFlipAlarmDrill` in a scratch
// copy, and only then writes `probe-flip-alarms.json`. A phase that is not yet true answers NOT YET (exit 10: the script
// polls); a phase that can no longer become true is REFUSED. Absent history or state is never filled in.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { ALARM_CONTRACT, suppressorName } from "../../controlPlane/alarmContract";
import { cliTime } from "../../controlPlane/evidence";
import { CERTIFIER_STORAGE_OVERRIDE } from "./certify";
import { DRILL_FILES, FLIP_ALARM_DRILL_FORMAT, flipRecordOf, judgeFlipAlarmDrill } from "./drills";
import { arr, num, obj, readEvidence, writeRecord } from "./evidence";

/** start.ts refuses this storage (the run-task-probe guard: a lost command override starts nothing) -- the same value. */
export const PROBE_STORAGE_OVERRIDE = CERTIFIER_STORAGE_OVERRIDE;
export const FLIP_ALARM_DIR = "flip-alarms";
export const FLIP_ALARM_OBSERVATION_FORMAT = "18COSMOS/L6-6-FLIP-ALARM-OBSERVATION/v1";
export const FLIP_ALARM_FILES = Object.freeze({
  injectTask: `${FLIP_ALARM_DIR}/inject-task.json`,
  injectLog: `${FLIP_ALARM_DIR}/inject-log.json`,
  injectLogStream: `${FLIP_ALARM_DIR}/inject-log-stream.json`,
  holdTask: `${FLIP_ALARM_DIR}/hold-task.json`,
  raw: (phase: FlipAlarmPhase, kind: "alarms" | "history" | "stamp") => `${FLIP_ALARM_DIR}/raw-${phase}-${kind}.json`,
  observation: (phase: FlipAlarmPhase) => `${FLIP_ALARM_DIR}/observe-${phase}.json`,
});
export const STARTED_BY = Object.freeze({ inject: "l6-6-flip-alarm-a1", hold: "l6-6-flip-alarm-hold" });
/** The suppressible alarm the hold drives (see the header: safe because the serving task's own 1 is left alone). */
export const HELD_ALARM_ID = "a12b-pool-writer-unconfirmed";
export const A1_ID = "a1-unexpected-task-loss";
export const HOLD_DEFAULT_SECONDS = 4500;
export const HOLD_MIN_SECONDS = 600;
export const HOLD_MAX_SECONDS = 5400;
export const TICK_MS = 15_000;
/** An A1 transition is this injection's only within this long after the task stopped. */
export const A1_BINDING_MS = 15 * 60_000;
/** `observe` answers NOT YET with this exit status (the script polls); 0 observed; anything else refused. */
export const EXIT_NOT_YET = 10;
/** The image's compiled encoder (Dockerfile: WORKDIR /app/server, dist/ copied whole). */
export const IMAGE_METRICS_MODULE = "/app/server/dist/server/src/aws/runtime/runtimeMetrics.js";

export type FlipAlarmPhase = "a1" | "during" | "after";
export type ProbeMode = "inject" | "hold";

const ENV_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const POOL_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;
const RUN_PATTERN = /^[a-z0-9][a-z0-9-]{5,39}$/;

/* ------------------------------------------------------------------ */
/* The in-task program and its overrides                                */
/* ------------------------------------------------------------------ */

/**
 * The standalone task's whole program (`node -e`). Parameters arrive as environment variables set by the overrides; it
 * validates them, requires the image's runtimeMetrics module (FA_METRICS_MODULE only for the offline tests) and writes
 * through `createEmfSink`. A marker line `L6-6-FLIP-ALARM-PROBE {...}` (not JSON, never EMF) says what it did.
 */
export const PROBE_PROGRAM = [
  '"use strict";',
  "const e=process.env,mode=e.FA_MODE,env=e.FA_ENVIRONMENT,pool=e.FA_POOL,run=e.FA_RUN;",
  "const say=(o)=>process.stdout.write('L6-6-FLIP-ALARM-PROBE '+JSON.stringify(Object.assign({run:run,mode:mode,pool:pool,at:Date.now()},o))+'\\n');",
  "const bad=(why)=>{say({refused:why});process.exit(2);};",
  "if(mode!=='inject'&&mode!=='hold')bad('mode');",
  "if(!/^[a-z][a-z0-9-]{0,31}$/.test(env||'')||/^prod/.test(env))bad('environment');",
  "if(!/^[a-z][a-z0-9-]{0,15}$/.test(pool||''))bad('pool');",
  "if(!/^[a-z0-9][a-z0-9-]{5,39}$/.test(run||''))bad('run');",
  `const m=require(e.FA_METRICS_MODULE||'${IMAGE_METRICS_MODULE}');`,
  "const sink=m.createEmfSink({context:{environment:env,pool:pool},now:Date.now,write:(l)=>process.stdout.write(l+'\\n')});",
  "if(mode==='inject'){",
  "const ok=sink.emit({event:'task-lost',metrics:{TaskLost:1,TaskSuperseded:0},properties:{cause:'other',why:'l6-6-flip-alarm-drill'}});",
  "say({emitted:ok,exit:ok?3:2});setTimeout(()=>process.exit(ok?3:2),3000);",
  "}else{",
  "const max=Number(e.FA_HOLD_SECONDS),tick=Number(e.FA_TICK_MS||'15000');",
  `if(!Number.isSafeInteger(max)||max<1||max>${HOLD_MAX_SECONDS})bad('hold-seconds');`,
  "if(!Number.isSafeInteger(tick)||tick<100||tick>60000)bad('tick');",
  "const end=Date.now()+max*1000;let n=0;",
  "const once=()=>{if(Date.now()>=end){say({done:'max-duration',emitted:n});process.exit(0);}if(sink.emit({event:'task-status',metrics:{PoolWriterConfirmed:0},properties:{why:'l6-6-flip-alarm-drill'}}))n+=1;};",
  "process.on('SIGTERM',()=>{say({done:'stopped',emitted:n});process.exit(0);});",
  "say({holding:'PoolWriterConfirmed=0',seconds:max});once();setInterval(once,tick);",
  "}",
].join("");

export interface ProbeOverrideInput {
  readonly mode: ProbeMode;
  readonly environment: string;
  readonly pool: string;
  readonly run: string;
  readonly holdSeconds?: number;
}

/** `ecs run-task --overrides` for one probe task: the command is the program, never start.ts; GS_STORAGE refuses a server. */
export function probeOverrides(input: ProbeOverrideInput): Record<string, unknown> {
  if (!ENV_PATTERN.test(input.environment) || /^prod/.test(input.environment)) throw new Error("the flip alarm probe runs only in a non-prod environment");
  if (!POOL_PATTERN.test(input.pool)) throw new Error("--pool must be a pool id");
  if (!RUN_PATTERN.test(input.run)) throw new Error("--run-id must be a run id");
  const hold = input.mode === "hold" ? (input.holdSeconds ?? HOLD_DEFAULT_SECONDS) : null;
  if (hold !== null && (!Number.isSafeInteger(hold) || hold < HOLD_MIN_SECONDS || hold > HOLD_MAX_SECONDS)) throw new Error(`--hold-seconds is ${HOLD_MIN_SECONDS}..${HOLD_MAX_SECONDS} (bounded: the window is at most 45 min)`);
  const environment = [
    { name: "GS_STORAGE", value: PROBE_STORAGE_OVERRIDE },
    { name: "FA_MODE", value: input.mode },
    { name: "FA_ENVIRONMENT", value: input.environment },
    { name: "FA_POOL", value: input.pool },
    { name: "FA_RUN", value: input.run },
    ...(hold === null ? [] : [{ name: "FA_HOLD_SECONDS", value: String(hold) }, { name: "FA_TICK_MS", value: String(TICK_MS) }]),
  ];
  return { containerOverrides: [{ name: "game-server", command: ["node", "-e", PROBE_PROGRAM], environment }] };
}

/* ------------------------------------------------------------------ */
/* Reading what the scripts captured                                    */
/* ------------------------------------------------------------------ */

type Verdict<T> = { readonly kind: "observed"; readonly value: T } | { readonly kind: "not-yet"; readonly reasons: readonly string[] } | { readonly kind: "refused"; readonly reasons: readonly string[] };
const refused = <T>(...reasons: string[]): Verdict<T> => ({ kind: "refused", reasons });
const notYet = <T>(...reasons: string[]): Verdict<T> => ({ kind: "not-yet", reasons });

interface Window {
  readonly from: string;
  readonly to: string;
  readonly opened_at: number;
  readonly expires_at: number;
  readonly closed_at: number | null;
}

/** The flip record's window, or why there is none. */
export function flipWindow(dir: string): { readonly window: Window | null; readonly problem: string | null } {
  const { record, problem } = flipRecordOf(dir);
  if (record === null) return { window: null, problem: `${DRILL_FILES.flipRecord}: ${String(problem)}` };
  if (record.window === null) return { window: null, problem: `${DRILL_FILES.flipRecord}: no window was opened (a dry run or a refused flip)` };
  return { window: { from: record.from, to: record.to, opened_at: record.window.opened_at, expires_at: record.window.expires_at, closed_at: record.window.closed_at }, problem: null };
}
const windowEndOf = (w: Window): number => Math.min(w.expires_at, w.closed_at ?? Number.POSITIVE_INFINITY);
const envOf = (container: Record<string, unknown>, name: string): string | undefined =>
  arr(container.environment).map(obj).find((v) => v.name === name)?.value as string | undefined;

interface ProbeTask {
  readonly taskArn: string;
  readonly taskDefinitionArn: string;
  readonly lastStatus: string;
  readonly createdAt: number | null;
  readonly startedAt: number | null;
  readonly stoppedAt: number | null;
  readonly exitCode: number | null;
  readonly imageDigest: string | null;
  readonly pool: string;
}

/** One probe task from a `describe-tasks` capture: exactly one task, started by the drill, running THE program. */
export function probeTaskOf(capture: unknown, mode: ProbeMode, environment: string): { readonly task: ProbeTask | null; readonly problem: string | null } {
  const tasks = arr(obj(capture).tasks).map(obj);
  if (tasks.length !== 1) return { task: null, problem: `expected exactly one ${mode} task in the capture, found ${tasks.length}` };
  const t = tasks[0];
  if (t.startedBy !== STARTED_BY[mode]) return { task: null, problem: `the task was started by ${String(t.startedBy)}, not ${STARTED_BY[mode]}` };
  const override = arr(obj(t.overrides).containerOverrides).map(obj).find((c) => c.name === "game-server");
  const command = arr(override?.command);
  if (override === undefined || command[0] !== "node" || command[1] !== "-e" || command[2] !== PROBE_PROGRAM) return { task: null, problem: "the task does not run the drill's program (its command override is not this build's PROBE_PROGRAM)" };
  if (envOf(override, "GS_STORAGE") !== PROBE_STORAGE_OVERRIDE) return { task: null, problem: `GS_STORAGE is not ${PROBE_STORAGE_OVERRIDE}: refused (a lost override must start nothing)` };
  if (envOf(override, "FA_MODE") !== mode || envOf(override, "FA_ENVIRONMENT") !== environment) return { task: null, problem: `the task is FA_MODE ${String(envOf(override, "FA_MODE"))} in ${String(envOf(override, "FA_ENVIRONMENT"))}, not ${mode} in ${environment}` };
  const pool = envOf(override, "FA_POOL") ?? "";
  if (typeof t.group === "string" && t.group.startsWith("service:")) return { task: null, problem: "the task belongs to a service: a drill task is always standalone" };
  const container = arr(t.containers).map(obj).find((c) => c.name === "game-server") ?? {};
  return {
    task: {
      taskArn: String(t.taskArn ?? ""),
      taskDefinitionArn: String(t.taskDefinitionArn ?? ""),
      lastStatus: String(t.lastStatus ?? ""),
      createdAt: cliTime(t.createdAt as never),
      startedAt: cliTime(t.startedAt as never),
      stoppedAt: cliTime(t.stoppedAt as never),
      exitCode: num(container.exitCode),
      imageDigest: typeof container.imageDigest === "string" ? container.imageDigest : null,
      pool,
    },
    problem: null,
  };
}

interface Stamp {
  readonly from: number;
  readonly to: number;
}
function stampOf(dir: string, phase: FlipAlarmPhase): { readonly stamp: Stamp | null; readonly problem: string | null } {
  const r = readEvidence(dir, FLIP_ALARM_FILES.raw(phase, "stamp"));
  if (!r.ok) return { stamp: null, problem: r.problem };
  const s = obj(r.value);
  const from = num(s.captured_from);
  const to = num(s.captured_to);
  if (from === null || to === null || to < from) return { stamp: null, problem: `${FLIP_ALARM_FILES.raw(phase, "stamp")}: captured_from / captured_to are not an interval` };
  return { stamp: { from, to }, problem: null };
}
const metricAlarms = (alarms: unknown) => new Map(arr(obj(alarms).MetricAlarms).map(obj).map((a) => [String(a.AlarmName), a]));
const compositeAlarms = (alarms: unknown) => new Map(arr(obj(alarms).CompositeAlarms).map(obj).map((a) => [String(a.AlarmName), a]));

/** Every deployed pool's flip-window suppressor, as CloudWatch lists it (discovered, never assumed). */
export function suppressorStates(alarms: unknown, environment: string): Record<string, string> {
  const pattern = new RegExp(`^gs-${environment}-([a-z][a-z0-9-]{0,15})-flip-window$`);
  const out: Record<string, string> = {};
  for (const [name, a] of metricAlarms(alarms)) {
    const m = pattern.exec(name);
    if (m !== null) out[m[1]] = String(a.StateValue);
  }
  return out;
}

const heldAlarmName = (environment: string, pool: string): string => `gs-${environment}-${pool}-${HELD_ALARM_ID}`;

/* ------------------------------------------------------------------ */
/* The three phases                                                     */
/* ------------------------------------------------------------------ */

export interface ObserveContext {
  readonly dir: string;
  readonly run: string;
  readonly environment: string;
  /** The deployment's pools (the certification's --pools): a suppressor of any other pool is refused. */
  readonly pools: readonly string[];
}

/** A1: the standalone task exited 3 inside the window, and A1 went to ALARM at/after that with its actions not suppressed. */
export function observeA1(ctx: ObserveContext): Verdict<Record<string, unknown>> {
  const { window: w, problem } = flipWindow(ctx.dir);
  if (w === null) return refused(String(problem));
  const cap = readEvidence(ctx.dir, FLIP_ALARM_FILES.injectTask);
  if (!cap.ok) return refused(`${cap.problem} (run-flip-alarm-probe inject records it)`);
  const { task, problem: tp } = probeTaskOf(cap.value, "inject", ctx.environment);
  if (task === null) return refused(String(tp));
  if (task.lastStatus !== "STOPPED" || task.stoppedAt === null) return refused(`the inject task is ${task.lastStatus}, not STOPPED with a stop time`);
  if (task.exitCode !== 3) return refused(`the inject task exited ${String(task.exitCode)}, not 3`);
  const end = windowEndOf(w);
  if (!(task.stoppedAt >= w.opened_at && task.stoppedAt < end)) return refused(`the inject task stopped at ${new Date(task.stoppedAt).toISOString()}, outside the flip window ${new Date(w.opened_at).toISOString()}..${new Date(end).toISOString()}`);
  const log = readEvidence(ctx.dir, FLIP_ALARM_FILES.injectLog);
  if (!log.ok) return refused(log.problem);
  const emf = arr(obj(log.value).events).map((e) => String(obj(e).message ?? "")).flatMap((m) => {
    try {
      const j = obj(JSON.parse(m));
      return j._aws !== undefined ? [j] : [];
    } catch {
      return [];
    }
  });
  const where = readEvidence(ctx.dir, FLIP_ALARM_FILES.injectLogStream);
  if (!where.ok) return refused(where.problem);
  const logStream = { group: String(obj(where.value).log_group ?? ""), stream: String(obj(where.value).log_stream ?? "") };
  if (!logStream.stream.endsWith(`/${task.taskArn.split("/").pop()}`)) return refused(`the captured log stream ${logStream.stream} is not the inject task's`);
  const lost = emf.find((j) => j.TaskLost === 1 && j.TaskSuperseded === 0 && j.Environment === ctx.environment);
  if (lost === undefined) return refused("the inject task's log holds no EMF record TaskLost=1 / TaskSuperseded=0 for this environment (the metric never left the task)");
  const alarms = readEvidence(ctx.dir, FLIP_ALARM_FILES.raw("a1", "alarms"));
  const history = readEvidence(ctx.dir, FLIP_ALARM_FILES.raw("a1", "history"));
  if (!alarms.ok || !history.ok) return refused(!alarms.ok ? alarms.problem : (history as { problem: string }).problem);
  const a1Name = `gs-${ctx.environment}-${A1_ID}`;
  const a1 = metricAlarms(alarms.value).get(a1Name);
  if (a1 === undefined) return refused(`${a1Name} is not in describe-alarms (never invented)`);
  const wrapped = [...compositeAlarms(alarms.value).values()].some((c) => typeof c.ActionsSuppressor === "string" && String(c.AlarmRule ?? "").includes(`"${a1Name}"`));
  const actionsSuppressed = a1.ActionsEnabled !== true || wrapped;
  if (actionsSuppressed) return refused(`${a1Name} actions are suppressed (ActionsEnabled ${String(a1.ActionsEnabled)}${wrapped ? ", wrapped by a suppressed composite" : ""}): A1 is never suppressible`);
  const transitions = arr(obj(history.value).AlarmHistoryItems)
    .map(obj)
    .filter((h) => h.AlarmName === a1Name && h.HistoryItemType === "StateUpdate")
    .map((h) => {
      let data: Record<string, unknown> = {};
      try {
        data = obj(JSON.parse(String(h.HistoryData ?? "{}")));
      } catch {
        data = {};
      }
      return { at: cliTime(h.Timestamp as never), to: String(obj(data.newState).stateValue ?? "") };
    })
    .filter((x) => x.at !== null && x.to === "ALARM" && (x.at as number) >= (task.stoppedAt as number) && (x.at as number) <= (task.stoppedAt as number) + A1_BINDING_MS)
    .sort((a, b) => (a.at as number) - (b.at as number));
  if (transitions.length === 0) return notYet(`no ${a1Name} transition to ALARM at or after the task's stop yet (history read; nothing assumed)`);
  return {
    kind: "observed",
    value: {
      task_arn: task.taskArn,
      task_definition: task.taskDefinitionArn,
      image_digest: task.imageDigest,
      created_at: task.createdAt,
      started_at: task.startedAt,
      exit_code: 3,
      stopped_at: task.stoppedAt,
      log_group: logStream.group,
      log_stream: logStream.stream,
      alarm: a1Name,
      state: "ALARM",
      alarm_at: transitions[0].at,
      actions_suppressed: false,
    },
  };
}

function heldPool(ctx: ObserveContext, w: Window): { readonly pool: string | null; readonly problem: string | null } {
  const cap = readEvidence(ctx.dir, FLIP_ALARM_FILES.holdTask);
  if (!cap.ok) return { pool: null, problem: `${cap.problem} (run-flip-alarm-probe hold-start records it)` };
  const { task, problem } = probeTaskOf(cap.value, "hold", ctx.environment);
  if (task === null) return { pool: null, problem };
  if (task.pool !== w.from && task.pool !== w.to) return { pool: null, problem: `the hold drives pool ${task.pool}, not one of the flip's pools (${w.from}, ${w.to})` };
  return { pool: task.pool, problem: null };
}

/** DURING: inside the window, the held alarm and its composite are ALARM with actions suppressed by the pool's window, and
 *  exactly the flip's two suppressors are ALARM. */
export function observeDuring(ctx: ObserveContext): Verdict<Record<string, unknown>> {
  const { window: w, problem } = flipWindow(ctx.dir);
  if (w === null) return refused(String(problem));
  const held = heldPool(ctx, w);
  if (held.pool === null) return refused(String(held.problem));
  const { stamp, problem: sp } = stampOf(ctx.dir, "during");
  if (stamp === null) return refused(String(sp));
  const end = windowEndOf(w);
  if (stamp.from < w.opened_at) return refused(`the observation began ${new Date(stamp.from).toISOString()}, before the window opened`);
  if (stamp.to >= end) return refused(`the observation ended ${new Date(stamp.to).toISOString()}, at or after the window's end ${new Date(end).toISOString()}: 'during' can no longer be observed`);
  const alarms = readEvidence(ctx.dir, FLIP_ALARM_FILES.raw("during", "alarms"));
  if (!alarms.ok) return refused(alarms.problem);
  const states = suppressorStates(alarms.value, ctx.environment);
  const unknown = Object.keys(states).filter((p) => !ctx.pools.includes(p));
  if (unknown.length > 0) return refused(`suppressors of pools outside the deployment: ${unknown.join(", ")}`);
  const others = ctx.pools.filter((p) => p !== w.from && p !== w.to);
  const strayAlarm = others.filter((p) => states[p] === "ALARM");
  if (strayAlarm.length > 0) return refused(`another pool's suppressor is ALARM during this flip: ${strayAlarm.join(", ")}`);
  const name = heldAlarmName(ctx.environment, held.pool);
  const raw = metricAlarms(alarms.value).get(name);
  const composite = compositeAlarms(alarms.value).get(`${name}-notify`);
  if (raw === undefined || composite === undefined) return refused(`${name} or ${name}-notify is not in describe-alarms (never invented)`);
  if (composite.ActionsSuppressor !== suppressorName(ctx.environment, held.pool)) return refused(`${name}-notify is suppressed by ${String(composite.ActionsSuppressor)}, not ${suppressorName(ctx.environment, held.pool)}`);
  const waiting: string[] = [];
  if (states[w.from] !== "ALARM" || states[w.to] !== "ALARM") waiting.push(`suppressors ${w.from} ${String(states[w.from])}, ${w.to} ${String(states[w.to])} (both must be ALARM)`);
  if (others.some((p) => states[p] !== "OK")) waiting.push(`other pools' suppressors not OK: ${JSON.stringify(states)}`);
  if (raw.StateValue !== "ALARM") waiting.push(`${name} is ${String(raw.StateValue)}`);
  if (composite.StateValue !== "ALARM") waiting.push(`${name}-notify is ${String(composite.StateValue)}`);
  if (composite.ActionsSuppressedBy !== "Alarm") waiting.push(`${name}-notify ActionsSuppressedBy ${String(composite.ActionsSuppressedBy)}`);
  if (waiting.length > 0) return notYet(...waiting);
  return {
    kind: "observed",
    value: {
      alarm: name,
      during: { at: stamp.to, composite_state: "ALARM", actions_suppressed_by: "Alarm", alarm_state: "ALARM", suppressor: String(composite.ActionsSuppressor) },
      suppressors: { at: stamp.to, states },
    },
  };
}

/** AFTER: at/after the window's actual end, the held alarm still fails and its composite's actions are no longer suppressed. */
export function observeAfter(ctx: ObserveContext): Verdict<Record<string, unknown>> {
  const { window: w, problem } = flipWindow(ctx.dir);
  if (w === null) return refused(String(problem));
  const held = heldPool(ctx, w);
  if (held.pool === null) return refused(String(held.problem));
  const during = readEvidence(ctx.dir, FLIP_ALARM_FILES.observation("during"), { ownRecord: true });
  if (!during.ok) return refused(`${during.problem} (observe the 'during' phase first)`);
  const name = heldAlarmName(ctx.environment, held.pool);
  if (obj(obj(during.value).observation).alarm !== name) return refused(`the 'during' observation is of ${String(obj(obj(during.value).observation).alarm)}, not ${name}`);
  const { stamp, problem: sp } = stampOf(ctx.dir, "after");
  if (stamp === null) return refused(String(sp));
  const end = windowEndOf(w);
  if (!Number.isFinite(end) || stamp.from < end) return notYet(`the window has not ended at ${new Date(stamp.from).toISOString()} (it ends ${Number.isFinite(end) ? new Date(end).toISOString() : "at its close or expiry"})`);
  const alarms = readEvidence(ctx.dir, FLIP_ALARM_FILES.raw("after", "alarms"));
  if (!alarms.ok) return refused(alarms.problem);
  const raw = metricAlarms(alarms.value).get(name);
  const composite = compositeAlarms(alarms.value).get(`${name}-notify`);
  if (raw === undefined || composite === undefined) return refused(`${name} or ${name}-notify is not in describe-alarms (never invented)`);
  if (raw.StateValue !== "ALARM") return refused(`${name} is ${String(raw.StateValue)} after the window: the condition must still fail (is the hold task still running?)`);
  if (composite.StateValue !== "ALARM" || composite.ActionsSuppressedBy !== "None") return notYet(`${name}-notify is ${String(composite.StateValue)}, ActionsSuppressedBy ${String(composite.ActionsSuppressedBy)} (waiting for None)`);
  return { kind: "observed", value: { alarm: name, after: { at: stamp.from, composite_state: "ALARM", actions_suppressed_by: "None", alarm_state: "ALARM" } } };
}

const OBSERVERS: Record<FlipAlarmPhase, (ctx: ObserveContext) => Verdict<Record<string, unknown>>> = { a1: observeA1, during: observeDuring, after: observeAfter };

/** Observe one phase; when observed, stage it (bound to this run and the flip record's window). */
export function stagePhase(ctx: ObserveContext, phase: FlipAlarmPhase): Verdict<string> {
  const v = OBSERVERS[phase](ctx);
  if (v.kind !== "observed") return v;
  const { window: w } = flipWindow(ctx.dir);
  const where = writeRecord(ctx.dir, FLIP_ALARM_FILES.observation(phase), { format: FLIP_ALARM_OBSERVATION_FORMAT, phase, run_id: ctx.run, environment: ctx.environment, flip: w === null ? null : { from: w.from, to: w.to, opened_at: w.opened_at, expires_at: w.expires_at }, observation: v.value });
  return { kind: "observed", value: where };
}

/* ------------------------------------------------------------------ */
/* The final record                                                     */
/* ------------------------------------------------------------------ */

/**
 * Assemble `probe-flip-alarms.json` from the three staged observations, each bound to THIS run and THIS flip record's
 * window; judge the candidate with `judgeFlipAlarmDrill` (unchanged) in a scratch copy; write it only if every check passes.
 */
export function recordFlipAlarms(ctx: ObserveContext): Verdict<string> {
  const { window: w, problem } = flipWindow(ctx.dir);
  if (w === null) return refused(String(problem));
  const staged: Partial<Record<FlipAlarmPhase, Record<string, unknown>>> = {};
  for (const phase of ["a1", "during", "after"] as const) {
    const r = readEvidence(ctx.dir, FLIP_ALARM_FILES.observation(phase), { ownRecord: true });
    if (!r.ok) return refused(`${r.problem} (stage-probe flip-alarms observe --phase ${phase})`);
    const v = obj(r.value);
    const f = obj(v.flip);
    if (v.format !== FLIP_ALARM_OBSERVATION_FORMAT || v.phase !== phase || v.run_id !== ctx.run || v.environment !== ctx.environment) return refused(`${FLIP_ALARM_FILES.observation(phase)} is not this run's ${phase} observation`);
    if (f.from !== w.from || f.to !== w.to || f.opened_at !== w.opened_at || f.expires_at !== w.expires_at) return refused(`${FLIP_ALARM_FILES.observation(phase)} is bound to another flip window`);
    staged[phase] = obj(v.observation);
  }
  const a1 = staged.a1 as Record<string, unknown>;
  const during = staged.during as Record<string, unknown>;
  const after = staged.after as Record<string, unknown>;
  if (during.alarm !== after.alarm) return refused(`'during' observed ${String(during.alarm)}, 'after' ${String(after.alarm)}: one alarm across the window`);
  const suppressible = ALARM_CONTRACT.alarms.find((a) => a.id === HELD_ALARM_ID)?.suppressible === true;
  if (!suppressible) return refused(`${HELD_ALARM_ID} is not suppressible in the alarm contract`);
  const record = {
    format: FLIP_ALARM_DRILL_FORMAT,
    run_id: ctx.run,
    environment: ctx.environment,
    flip: { from: w.from, to: w.to, opened_at: w.opened_at, expires_at: w.expires_at, closed_at: w.closed_at },
    cases: {
      "exit3-in-window-pages-a1": a1,
      "suppressed-alarm-actionable-after-window": { alarm: during.alarm, during: during.during, after: after.after },
      "suppressors-during-window": during.suppressors,
    },
  };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gs-flip-alarms-"));
  try {
    fs.copyFileSync(path.join(ctx.dir, DRILL_FILES.flipRecord), path.join(scratch, DRILL_FILES.flipRecord));
    writeRecord(scratch, DRILL_FILES.flipAlarms, record);
    const failed = judgeFlipAlarmDrill(scratch, { run: ctx.run, environment: ctx.environment, pools: ctx.pools }).filter((c) => c.status !== "pass");
    if (failed.length > 0) return refused(...failed.map((c) => `${c.name}: ${c.detail}`));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return { kind: "observed", value: writeRecord(ctx.dir, DRILL_FILES.flipAlarms, record) };
}

/** Whether the flip record's window is open now (the scripts refuse to inject or hold outside one). */
export function windowOpen(dir: string, now: number): { readonly open: boolean; readonly detail: string } {
  const { window: w, problem } = flipWindow(dir);
  if (w === null) return { open: false, detail: String(problem) };
  const end = windowEndOf(w);
  return now >= w.opened_at && now < end ? { open: true, detail: `${w.from} -> ${w.to}: open until ${new Date(end).toISOString()}` } : { open: false, detail: `${w.from} -> ${w.to}: not open now (${new Date(w.opened_at).toISOString()}..${new Date(end).toISOString()})` };
}
