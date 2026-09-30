// server/src/aws/deploy/staging/drain.ts
//
// ==================================================================
//  LIVE-6 L6-6 §2: DRAIN ORDERING -- PROVEN FROM ECS'S OWN TIMESTAMPS, NEVER FROM "STOP-FIRST"
// ==================================================================
//
// Stop-first (minimumHealthyPercent 0 / maximumPercent 100) is NOT a no-overlap guarantee (L5-8 review M1: ECS counts only
// RUNNING/PENDING against maximumPercent, so it may start the new task while the old one drains). The production procedure
// for any change that replaces a pool's task is `infra/aws/scripts/drain-pool` THEN `terraform apply`. This section
// proves that procedure happened, for each replaced pool, from evidence ECS itself wrote:
//
//   drain-<pool>/tasks-before.json   `describe-tasks` of the pool's RUNNING task(s), listed before the scale-down
//   drain-<pool>/tasks-after.json    the same tasks after the drain: every one STOPPED, its game-server container exit 0
//                                    (the graceful shutdown -- exit 3 would be a fenced, overlapped task)
//   drain-<pool>/service-after.json  the service after the drain: desired 0, running 0, pending 0
//   running-tasks.json               (captured after the apply) the pool's task now: NOT one of the drained ones, and
//                                    CREATED after the last drained task STOPPED -- drain -> zero -> apply/start
//
// Scenarios: `read-only` certification replaces nothing, so it needs no drain (the section says so explicitly -- it does
// not pass by default and it never cites stop-first as evidence); `replacement` requires this proof for every replaced
// pool, and a pool with nothing running before is not a replacement.

import * as path from "path";

import type { Check } from "../deployVerify";
import { expectedNames } from "../deployVerify";
import { arr, EVIDENCE, evidenceName, judge, num, obj, readEvidence, str } from "./evidence";

export const DRAIN_FILES = Object.freeze({ tasksBefore: "tasks-before.json", tasksAfter: "tasks-after.json", serviceAfter: "service-after.json", stamp: "drain.json" });
export const drainDir = (pool: string): string => `drain-${pool}`;

/** An ECS timestamp as the AWS CLI prints it (ISO-8601 in CLI v2; epoch seconds in v1), in ms. */
export const ecsTime = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
};

const gameExitCode = (task: Record<string, unknown>): number | null => {
  const container = arr(task.containers).map(obj).find((c) => c.name === "game-server");
  return num(container?.exitCode);
};

export function judgeDrain(dir: string, pool: string, environment: string, runningNow: readonly Record<string, unknown>[], run: { readonly run: string; readonly notAfter: string | null }): Check[] {
  const label = `drain ${pool}`;
  const where = drainDir(pool);
  const before = readEvidence(dir, evidenceName(where, DRAIN_FILES.tasksBefore));
  const after = readEvidence(dir, evidenceName(where, DRAIN_FILES.tasksAfter));
  const service = readEvidence(dir, evidenceName(where, DRAIN_FILES.serviceAfter));
  const stamp = readEvidence(dir, evidenceName(where, DRAIN_FILES.stamp));
  const missing = [before, after, service, stamp].filter((r) => !r.ok).map((r) => (r.ok ? "" : r.problem));
  if (missing.length > 0) return [judge(`${label}: evidence`, false, "", `${missing.join("; ")} (run infra/aws/scripts/drain-pool with the evidence directory and this run id before the apply)`)];
  const checks: Check[] = [];
  /* THIS run's drain, before this run's prerequisite (which examined the deployment the drain made room for). */
  const s = obj(stamp.ok ? stamp.value : null);
  const drainedAt = Date.parse(String(s.drained_at));
  const notAfter = run.notAfter === null ? Number.NaN : Date.parse(run.notAfter);
  checks.push(
    judge(
      `${label}: this run's drain`,
      s.run_id === run.run && s.pool === pool && Number.isFinite(drainedAt) && Number.isFinite(notAfter) && drainedAt <= notAfter,
      `drained ${String(s.drained_at)} for ${run.run}, before the prerequisite (${String(run.notAfter)})`,
      s.run_id !== run.run || s.pool !== pool ? `the drain evidence is run ${String(s.run_id)} pool ${String(s.pool)}'s (a drain from another run proves nothing about this apply)` : `drained ${String(s.drained_at)}, not before the prerequisite (${String(run.notAfter)})`,
    ),
  );
  const group = `service:${expectedNames(environment, 1).service(pool)}`;
  const oldTasks = arr(obj(before.ok ? before.value : null).tasks).map(obj).filter((t) => t.group === group);
  const oldArns = oldTasks.map((t) => String(t.taskArn));
  const stopped = arr(obj(after.ok ? after.value : null).tasks).map(obj).filter((t) => oldArns.includes(String(t.taskArn)));
  checks.push(judge(`${label}: a task was serving before`, oldTasks.length >= 1, `${oldTasks.length} task(s) drained`, "no task of the pool was running before the drain: this is not a replacement"));
  const notStopped = oldArns.filter((arn) => !stopped.some((t) => t.taskArn === arn && t.lastStatus === "STOPPED" && ecsTime(t.stoppedAt) !== null));
  const notGraceful = stopped.filter((t) => gameExitCode(t) !== 0).map((t) => `${String(t.taskArn).split("/").pop()} exit ${String(gameExitCode(t))}`);
  checks.push(
    judge(
      `${label}: every drained task STOPPED after its graceful shutdown`,
      oldTasks.length >= 1 && notStopped.length === 0 && notGraceful.length === 0,
      "STOPPED, game-server exit 0",
      [notStopped.length > 0 ? `not STOPPED: ${notStopped.map((a) => a.split("/").pop()).join(", ")}` : "", notGraceful.length > 0 ? `not graceful: ${notGraceful.join(", ")} (exit 3 is a fenced task: the new one overlapped it)` : ""].filter((x) => x !== "").join("; "),
    ),
  );
  const svc = arr(obj(service.ok ? service.value : null).services).map(obj)[0] ?? {};
  checks.push(
    judge(
      `${label}: zero running and pending before the apply`,
      svc.desiredCount === 0 && svc.runningCount === 0 && svc.pendingCount === 0,
      "desired 0, running 0, pending 0",
      `desired ${String(svc.desiredCount)}, running ${String(svc.runningCount)}, pending ${String(svc.pendingCount)}`,
    ),
  );
  const lastStop = Math.max(...stopped.map((t) => ecsTime(t.stoppedAt) ?? Number.POSITIVE_INFINITY), Number.NEGATIVE_INFINITY);
  const current = runningNow.map((t) => ({ arn: String(t.taskArn), created: ecsTime(t.createdAt) }));
  const reused = current.filter((c) => oldArns.includes(c.arn));
  const early = current.filter((c) => c.created === null || !(c.created > lastStop));
  checks.push(
    judge(
      `${label}: the new task started only after the drain`,
      current.length >= 1 && reused.length === 0 && early.length === 0 && Number.isFinite(lastStop),
      `the running task was created ${current.map((c) => new Date(c.created ?? 0).toISOString()).join(", ")}, after the last drained task stopped (${Number.isFinite(lastStop) ? new Date(lastStop).toISOString() : "?"})`,
      current.length === 0
        ? `no running task of ${pool} in ${EVIDENCE.runningTasks} (capture it after the apply)`
        : reused.length > 0
          ? "the running task is one of the drained ones (nothing was replaced)"
          : `a running task was created ${early.map((c) => (c.created === null ? "at an unknown time" : new Date(c.created).toISOString())).join(", ")}, not after the last drained task stopped (${Number.isFinite(lastStop) ? new Date(lastStop).toISOString() : "?"}): overlap`,
    ),
  );
  return checks;
}

/** The section's statement for a read-only certification: nothing replaced, nothing to drain -- and why stop-first is not the proof. */
export const READ_ONLY_DRAIN_NOTE =
  "not required: a read-only certification replaces no task. (A replacement certification must prove drain -> zero running/pending -> apply/start from ECS task timestamps; stop-first 0/100 alone never proves it.)";

export const firstRunningTaskArn = (tasks: readonly Record<string, unknown>[]): string | null => str(tasks[0]?.taskArn);
