// server/src/aws/deploy/staging/restoreAlarmDrill.ts
//
// ==================================================================
//  LIVE-6 L6-6 (RESTORE DRILL): A SUPPORTED PRODUCER FOR `probe-restore-alarms.json` -- PRECHECK, OBSERVE, RECORD
// ==================================================================
//
// `drills.ts` judges `probe-restore-alarms.json` (RESTORE_ALARM_DRILL_FORMAT) and nothing produced it. This is the
// producer, over `restoreAlarmProbe.ts` (the probe program and the one derivation of each case from AWS's answers). Its
// commands (`awsDeploy stage-probe restore-alarms ...`, run by infra/aws/scripts/run-restore-alarm-probe.{sh,ps1}) read and
// write ONLY the evidence directory; the scripts make the AWS calls.
//
//   precheck   right before a probe task is started, over the pre-injection describe-alarms the script just captured:
//              the case's alarm exists and is NOT in ALARM (else NOT YET: an earlier injection's datapoint is still being
//              evaluated), the pool is one of the deployment's, and -- for an injection meant to overlap the staging
//              flip-suppression test -- that test's window is open with margin and BOTH its pools' suppressors are ALARM
//              (else NOT YET while there is time). Only then is the launch record written (machine); the script starts the
//              task only on exit 0. A previous attempt of the same case is moved aside (`superseded/`), never deleted.
//   observe    `deriveRestoreCase` over the latest captures: OBSERVED (staged as observe-<case>.json), NOT YET (exit 10, the
//              script polls), REFUSED.
//   record     all five staged observations, each re-derived from the captures (a capture changed since it was staged is
//              refused: observe again), at least one inside the staging flip-suppression overlap test, that test closed
//              with SYSTEM/ROUTING read unchanged; the candidate is judged by `judgeRestoreAlarmDrill` in a scratch copy of
//              the evidence, and only then is `probe-restore-alarms.json` written.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { suppressorName } from "../../controlPlane/alarmContract";
import { DRILL_FILES, judgeRestoreAlarmDrill, RESTORE_ALARM_DRILL_FORMAT } from "./drills";
import { obj, readEvidence, stableStringify, writeRecord } from "./evidence";
import {
  deriveRestoreCase,
  notYet,
  OVERLAP_MARGIN_MS,
  overlapRoutingProblem,
  refused,
  RESTORE_ALARM_DIR,
  RESTORE_ALARM_FILES,
  RESTORE_CASE_ALARM,
  RESTORE_CASES,
  RESTORE_LAUNCH_FORMAT,
  RESTORE_OBSERVATION_FORMAT,
  restoreAlarmName,
  stampOf,
  suppressionRecordOf,
  type LaunchRecord,
  type RestoreAlarmContext,
  type RestoreCase,
  type Verdict,
} from "./restoreAlarmProbe";

export interface RestoreDrillContext extends RestoreAlarmContext {
  /** The deployment's pools (the certification's --pools). */
  readonly pools: readonly string[];
}

const iso = (ms: number): string => new Date(ms).toISOString();
const metricStates = (alarms: unknown): Map<string, string> => new Map((Array.isArray(obj(alarms).MetricAlarms) ? (obj(alarms).MetricAlarms as unknown[]) : []).map(obj).map((a) => [String(a.AlarmName), String(a.StateValue)]));

/** Move a previous attempt's files of `c` aside (never deleted): `restore-alarms/superseded/<c>-<when>/`. */
function supersede(dir: string, c: RestoreCase, now: number): string | null {
  const files = [RESTORE_ALARM_FILES.launch(c), RESTORE_ALARM_FILES.task(c), RESTORE_ALARM_FILES.taskStopped(c), RESTORE_ALARM_FILES.log(c), RESTORE_ALARM_FILES.logStream(c), RESTORE_ALARM_FILES.raw(c, "alarms"), RESTORE_ALARM_FILES.raw(c, "history"), RESTORE_ALARM_FILES.raw(c, "suppressor-history"), RESTORE_ALARM_FILES.raw(c, "stamp"), RESTORE_ALARM_FILES.observation(c)].filter((f) => fs.existsSync(path.join(dir, f)));
  if (files.length === 0) return null;
  const into = `${RESTORE_ALARM_DIR}/superseded/${c}-${now}`;
  fs.mkdirSync(path.join(dir, into), { recursive: true });
  for (const f of files) fs.renameSync(path.join(dir, f), path.join(dir, into, path.basename(f)));
  return into;
}

/**
 * Before a probe task is started (see the header). OBSERVED: the launch record was written and the task may be started;
 * NOT YET: poll (recapture the pre-injection alarms first); REFUSED: nothing may be started.
 */
export function precheckRestoreCase(ctx: RestoreDrillContext, input: { readonly case: RestoreCase; readonly pool: string; readonly overlap: boolean; readonly now: number }): Verdict<string> {
  const c = input.case;
  if (/^prod/.test(ctx.environment)) return refused("the restore alarm drill never runs in a prod* environment");
  if (!ctx.pools.includes(input.pool)) return refused(`pool ${input.pool} is not one of the deployment's pools [${ctx.pools.join(", ")}]`);
  if (c === "r3" && input.overlap) return refused("R3's hold lasts more than an hour; the overlap is shown with a counter case (r1, a4g, a4i or r2)");
  const alarm = restoreAlarmName(ctx.environment, c, input.pool);
  const stamp = stampOf(ctx.dir, RESTORE_ALARM_FILES.raw(c, "pre-stamp"));
  if ("problem" in stamp) return refused(stamp.problem);
  if (input.now - stamp.to > 5 * 60_000) return refused(`the pre-injection capture is from ${iso(stamp.to)}: capture it again right before the task is started`);
  const pre = readEvidence(ctx.dir, RESTORE_ALARM_FILES.raw(c, "pre-alarms"));
  if (!pre.ok) return refused(pre.problem);
  const states = metricStates(pre.value);
  const state = states.get(alarm);
  if (state === undefined) return refused(`${alarm} is not in describe-alarms (the deployment has no such alarm${c === "r2" || c === "r3" ? ": R2 and R3 exist only with escrow" : ""})`);
  if (state === "ALARM") return c === "r3" ? refused(`${alarm} is already ALARM: no transition could be bound to this hold`) : notYet(`${alarm} is ALARM (an earlier datapoint is still being evaluated): wait until it is not, then inject`);
  let suppressors: Record<string, string> | null = null;
  if (input.overlap) {
    const w = suppressionRecordOf(ctx.dir);
    if ("problem" in w) return refused(`an overlapping injection needs the staging flip-suppression overlap test: ${w.problem}`);
    if (w.environment !== ctx.environment) return refused(`the suppression-overlap test is ${w.environment}'s`);
    if (w.open.outcome !== "published") return refused(`the suppression-overlap test's datapoints were not published (${w.open.outcome})`);
    if (w.closed !== null) return refused("the suppression-overlap test was already closed");
    const strangers = w.pools.filter((p) => !ctx.pools.includes(p));
    if (strangers.length > 0) return refused(`the suppression-overlap test names pools outside the deployment: ${strangers.join(", ")}`);
    if (input.now < w.opened_at) return refused(`the suppression-overlap window opens at ${iso(w.opened_at)}`);
    if (input.now > w.expires_at - OVERLAP_MARGIN_MS) return refused(`the suppression-overlap window ends at ${iso(w.expires_at)}: less than ${OVERLAP_MARGIN_MS / 60_000} min are left for the injection to land inside it (open a new test)`);
    suppressors = Object.fromEntries(w.pools.map((p) => [p, states.get(suppressorName(ctx.environment, p)) ?? "ABSENT"]));
    const absent = w.pools.filter((p) => suppressors?.[p] === "ABSENT");
    if (absent.length > 0) return refused(`no suppressor alarm for ${absent.join(", ")} in this environment's describe-alarms`);
    const waiting = w.pools.filter((p) => suppressors?.[p] !== "ALARM");
    if (waiting.length > 0) return notYet(`suppressors not ALARM yet: ${waiting.map((p) => `${suppressorName(ctx.environment, p)} ${String(suppressors?.[p])}`).join(", ")} (the mechanism turns them ALARM within about two minutes of the open)`);
  }
  const moved = supersede(ctx.dir, c, input.now);
  const launch: LaunchRecord = {
    format: RESTORE_LAUNCH_FORMAT,
    run_id: ctx.run,
    environment: ctx.environment,
    case: c,
    alarm,
    pool: input.pool,
    overlap: input.overlap,
    prechecked_at: input.now,
    pre: { captured_from: stamp.from, captured_to: stamp.to, alarm_state: state, suppressors },
  };
  writeRecord(ctx.dir, RESTORE_ALARM_FILES.launch(c), launch);
  return { kind: "observed", value: `${alarm} is ${state}${input.overlap ? `; suppressors ${JSON.stringify(suppressors)}` : ""}: start the ${c} probe task${moved === null ? "" : ` (the previous attempt moved to ${moved})`}` };
}

/** Observe one case; when observed, stage it. */
export function stageRestoreCase(ctx: RestoreAlarmContext, c: RestoreCase): Verdict<string> {
  const v = deriveRestoreCase(ctx, c);
  if (v.kind !== "observed") return v;
  const where = writeRecord(ctx.dir, RESTORE_ALARM_FILES.observation(c), { format: RESTORE_OBSERVATION_FORMAT, run_id: ctx.run, environment: ctx.environment, case: c, observation: v.value });
  return { kind: "observed", value: `${where} -- ${v.value.alarm} ALARM at ${iso(v.value.alarm_at)} (injected ${iso(v.value.injected_at)})${v.value.suppression_overlap !== null ? ", inside the staging flip-suppression overlap test (both suppressors ALARM at the injection)" : ""}` };
}

export const RESTORE_ALARM_STATEMENT = "alarm-pipeline injections through the production EMF encoder and each decision's own metric set, observed in CloudWatch; not reproductions of a destructive runtime fault";

/** Assemble, judge and write `probe-restore-alarms.json` (see the header). */
export function recordRestoreAlarms(ctx: RestoreDrillContext): Verdict<string> {
  const cases: Record<string, unknown> = {};
  let overlapped = 0;
  for (const c of RESTORE_CASES) {
    const staged = readEvidence(ctx.dir, RESTORE_ALARM_FILES.observation(c), { ownRecord: true });
    if (!staged.ok) return refused(`${staged.problem} (run-restore-alarm-probe observe ... ${c})`);
    const s = obj(staged.value);
    if (s.format !== RESTORE_OBSERVATION_FORMAT || s.run_id !== ctx.run || s.environment !== ctx.environment || s.case !== c) return refused(`${RESTORE_ALARM_FILES.observation(c)} is not this run's ${c} observation`);
    const again = deriveRestoreCase(ctx, c);
    if (again.kind !== "observed") return refused(`${c} no longer derives from its captures (${again.reasons.join("; ")}): observe it again`);
    if (stableStringify(again.value) !== stableStringify(s.observation)) return refused(`${c}'s captures changed since it was staged: observe it again`);
    if (again.value.suppression_overlap !== null) overlapped += 1;
    cases[RESTORE_CASE_ALARM[c]] = again.value;
  }
  if (overlapped === 0) return refused("no case was injected inside the staging flip-suppression overlap test (inject one counter case with overlap while `gamesDoctor aws suppression-overlap` is open)");
  const routing = overlapRoutingProblem(ctx.dir);
  if (routing !== null) return refused(routing);
  const record = { format: RESTORE_ALARM_DRILL_FORMAT, run_id: ctx.run, environment: ctx.environment, statement: RESTORE_ALARM_STATEMENT, cases };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gs-restore-alarms-"));
  try {
    fs.cpSync(path.join(ctx.dir, RESTORE_ALARM_DIR), path.join(scratch, RESTORE_ALARM_DIR), { recursive: true });
    writeRecord(scratch, DRILL_FILES.restoreAlarms, record);
    const failed = judgeRestoreAlarmDrill(scratch, { run: ctx.run, environment: ctx.environment, pools: ctx.pools }).filter((c) => c.status !== "pass");
    if (failed.length > 0) return refused(...failed.map((c) => `${c.name}: ${c.detail}`));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return { kind: "observed", value: writeRecord(ctx.dir, DRILL_FILES.restoreAlarms, record) };
}
