// server/src/aws/deploy/staging/prerequisite.ts
//
// ==================================================================
//  LIVE-6 L6-6 §1: THE DEPLOYMENT-STATE PREREQUISITE -- NOTHING IS PROBED UNTIL THE DEPLOYMENT IS SETTLED AND KNOWN
// ==================================================================
//
// The L5-8 verifier (`deployVerify.ts`, run live by `stage-cert` through the same code as `awsDeploy verify`) already
// proves the documents, tables, APPGEN, SYSTEM/ROUTING, the KMS keys, and -- from the control-plane evidence -- that each
// captured task definition is the revision its service runs, the stop-first services, the target group and the /gs* edge.
// The staging gate adds what a probe must be able to rely on (pure checks over three more read-only captures):
//
//   SETTLED        each pool's service has exactly ONE deployment, `rolloutState` COMPLETED, runningCount = desiredCount
//                  and pendingCount 0 (the verifier's "settled" only compares task-definition ARNs: a PRIMARY deployment
//                  still IN_PROGRESS on the same revision would pass it);
//   THE RUNNING TASK  exactly desiredCount RUNNING tasks per service (running-tasks.json), each running the service's
//                  task definition -- the revision the verifier examined is the one executing;
//   NOTHING BESIDE IT  every RUNNING task in the cluster (cluster-tasks.json) belongs to a pool's service: a `run-task` of
//                  a pool's definition beside its service would fence it (infra/aws/README.md "Rollout");
//   TARGET HEALTH  the primary's target group has exactly one target, healthy through /gs/readyz, and it is the primary's
//                  running task (its ENI address).
//
// Any failure refuses the certification: the probes are not judged against a deployment in motion.

import type { Check } from "../deployVerify";
import { expectedNames } from "../deployVerify";
import { arr, judge, num, obj, str } from "./evidence";

type Json = unknown;

export interface PrerequisiteExpect {
  readonly environment: string;
  readonly pools: readonly string[];
  readonly primaryPool: string;
}

const serviceOf = (servicesDoc: Json, environment: string, pool: string): Record<string, Json> | undefined =>
  arr(obj(servicesDoc).services)
    .map(obj)
    .find((s) => s.serviceName === expectedNames(environment, 1).service(pool));

/** SETTLED: one deployment, COMPLETED, running = desired, nothing pending (per pool). */
export function checkServicesSettled(servicesDoc: Json, expect: PrerequisiteExpect): Check[] {
  const checks: Check[] = [];
  for (const pool of expect.pools) {
    const label = `prerequisite: service ${pool}`;
    const s = serviceOf(servicesDoc, expect.environment, pool);
    if (s === undefined) {
      checks.push(judge(`${label}: settled`, false, "", "not in services.json"));
      continue;
    }
    const deployments = arr(s.deployments).map(obj);
    const rollout = deployments.map((d) => String(d.rolloutState ?? "(none)"));
    const desired = num(s.desiredCount);
    const running = num(s.runningCount);
    const pending = num(s.pendingCount);
    const problems = [
      deployments.length === 1 ? null : `${deployments.length} deployments (a deployment is in progress)`,
      deployments.length === 1 && deployments[0].rolloutState === "COMPLETED" ? null : `rolloutState [${rollout.join(", ")}] (not COMPLETED)`,
      desired !== null && running === desired ? null : `running ${String(running)} of desired ${String(desired)}`,
      pending === 0 ? null : `pending ${String(pending)}`,
      pool !== expect.primaryPool || desired === 1 ? null : `the primary's desired count is ${String(desired)}, not 1`,
    ].filter((p): p is string => p !== null);
    checks.push(judge(`${label}: settled`, problems.length === 0, `one COMPLETED deployment, running ${String(running)} = desired, nothing pending`, problems.join("; ")));
  }
  return checks;
}

/** The address of a task's ENI (awsvpc), from `describe-tasks`. */
export const taskPrivateIp = (task: Record<string, Json>): string | null => {
  for (const attachment of arr(task.attachments).map(obj)) {
    for (const detail of arr(attachment.details).map(obj)) if (detail.name === "privateIPv4Address") return str(detail.value);
  }
  return null;
};

/** THE RUNNING TASK: exactly desiredCount RUNNING tasks per service, each on the service's task definition. */
export function checkRunningTasks(tasksDoc: Json, servicesDoc: Json, expect: PrerequisiteExpect): { readonly checks: Check[]; readonly running: ReadonlyMap<string, readonly Record<string, Json>[]> } {
  const names = expectedNames(expect.environment, 1);
  const tasks = arr(obj(tasksDoc).tasks).map(obj);
  const checks: Check[] = [];
  const running = new Map<string, Record<string, Json>[]>();
  for (const pool of expect.pools) {
    const label = `prerequisite: running task ${pool}`;
    const s = serviceOf(servicesDoc, expect.environment, pool);
    const want = str(s?.taskDefinition);
    const mine = tasks.filter((t) => t.group === `service:${names.service(pool)}`);
    const live = mine.filter((t) => t.lastStatus === "RUNNING" && t.desiredStatus === "RUNNING");
    running.set(pool, live);
    const desired = num(s?.desiredCount);
    const wrong = live.filter((t) => t.taskDefinitionArn !== want).map((t) => String(t.taskDefinitionArn));
    const other = mine.filter((t) => !(t.lastStatus === "RUNNING" && t.desiredStatus === "RUNNING")).map((t) => `${String(t.lastStatus)}/${String(t.desiredStatus)}`);
    const problems = [
      want === null ? "the service names no task definition" : null,
      desired !== null && live.length === desired ? null : `${live.length} RUNNING task(s), desired ${String(desired)}`,
      wrong.length === 0 ? null : `a task runs ${wrong.join(", ")}, not the service's ${String(want)}`,
      other.length === 0 ? null : `task(s) in transition [${other.join(", ")}]`,
    ].filter((p): p is string => p !== null);
    checks.push(judge(`${label}: the examined revision is the one running`, problems.length === 0, `${live.length} task(s) on ${String(want)}`, problems.join("; ")));
  }
  return { checks, running };
}

/** NOTHING BESIDE IT: every RUNNING task in the cluster is a pool service's task -- and the cluster listing really is
 *  the cluster's: it holds every service task `running-tasks.json` holds (an empty or failed listing proves nothing). */
export function checkClusterTasks(clusterDoc: Json, expect: PrerequisiteExpect, runningDoc: Json): Check[] {
  const names = expectedNames(expect.environment, 1);
  const groups = new Set(expect.pools.map((p) => `service:${names.service(p)}`));
  const listedTasks = arr(obj(clusterDoc).tasks).map(obj);
  const strays = listedTasks.filter((t) => t.lastStatus !== "STOPPED" && !groups.has(String(t.group))).map((t) => `${String(t.group)} ${String(t.taskDefinitionArn)} (${String(t.lastStatus)})`);
  const listed = Array.isArray(obj(clusterDoc).tasks);
  const clusterArns = new Set(listedTasks.map((t) => String(t.taskArn)));
  const serviceArns = arr(obj(runningDoc).tasks).map((t) => String(obj(t).taskArn));
  const unlisted = serviceArns.filter((arn) => !clusterArns.has(arn));
  return [
    judge(
      "prerequisite: no task beside the services",
      listed && strays.length === 0 && serviceArns.length > 0 && unlisted.length === 0,
      `every one of the cluster's ${listedTasks.length} task(s) belongs to a pool's service`,
      !listed
        ? "cluster-tasks.json lists no `tasks`"
        : strays.length > 0
          ? `task(s) outside the services: ${strays.join("; ")} (a pool's definition run beside its service fences it)`
          : `the cluster listing is incomplete: it lacks ${unlisted.length || "every"} service task(s) running-tasks.json holds (a failed or empty listing proves nothing)`,
    ),
  ];
}

/** TARGET HEALTH: one healthy target, and it is the primary's running task. */
export function checkTargetHealth(healthDoc: Json, primaryTasks: readonly Record<string, Json>[]): Check[] {
  const targets = arr(obj(healthDoc).TargetHealthDescriptions).map(obj);
  const addresses = primaryTasks.map(taskPrivateIp).filter((ip): ip is string => ip !== null);
  const states = targets.map((t) => `${String(obj(t.Target).Id)}=${String(obj(t.TargetHealth).State)}`);
  const ok = targets.length === 1 && obj(targets[0].TargetHealth).State === "healthy" && addresses.length === 1 && obj(targets[0].Target).Id === addresses[0];
  return [
    judge(
      "prerequisite: target health",
      ok,
      `one healthy target (/gs/readyz 200), the primary's running task`,
      `targets [${states.join(", ")}], the primary's task address ${addresses.join(", ") || "(none)"}: expected exactly that task, healthy`,
    ),
  ];
}

/** The BUILD_ID each running task definition carries (from the captured task definitions). */
export function buildIdOf(taskDefinitionDoc: Json): string | null {
  const containers = arr(obj(obj(taskDefinitionDoc).taskDefinition).containerDefinitions).map(obj);
  const game = containers.find((c) => c.name === "game-server");
  const env = arr(game?.environment).map(obj);
  return str(env.find((e) => e.name === "BUILD_ID")?.value);
}
