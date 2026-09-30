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
//   NOTHING BESIDE IT  every task in the cluster that is not STOPPED (cluster-tasks.json) is a pool service's settled task:
//                  a `run-task` of a pool's definition beside its service would fence it (infra/aws/README.md "Rollout"),
//                  and a draining, starting or old-revision task is a deployment in motion. L6-6P: the listing is the
//                  COMPLETE one -- desired RUNNING and desired STOPPED, every `list-tasks` page, every task described in
//                  batches (50 per call since W1; judged 1-100) with no failure -- or the prerequisite FAILS (`readClusterListing`);
//   TARGET HEALTH  the primary's target group has exactly one target, healthy through /gs/readyz, and it is the primary's
//                  running task (its ENI address).
//
// Any failure refuses the certification: the probes are not judged against a deployment in motion.

import type { Check } from "../deployVerify";
import { expectedNames } from "../deployVerify";
import { arr, fail, judge, num, obj, str } from "./evidence";

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

/* ------------------------------------------------------------------ */
/* NOTHING BESIDE IT: the complete cluster listing (L6-6P)              */
/* ------------------------------------------------------------------ */

/** capture-evidence's cluster listing (`cluster-tasks.json`). An older `{tasks, failures}` answer (one desired-RUNNING
 *  `list-tasks` page cut at 100) is not this format and FAILS: it cannot show a draining task or the 101st task. */
export const CLUSTER_TASKS_FORMAT = "18COSMOS/L6-6P-CLUSTER-TASKS/v1";
/** Every desired status ECS sets. ListTasks also accepts PENDING, but ECS never sets a task's DESIRED status to it (only
 *  lastStatus), so RUNNING and STOPPED together are every task the cluster still reports -- a task draining under
 *  SIGTERM (lastStatus RUNNING/DEACTIVATING/STOPPING/DEPROVISIONING) has desired STOPPED. */
export const CLUSTER_DESIRED_STATUSES = Object.freeze(["RUNNING", "STOPPED"] as const);
/** The bound a listing's batch is judged against: 1..100, DescribeTasks' own maximum per call (a batch over it cannot be one
 *  whole answer). Unchanged by LIVE-6 W1, so a complete listing captured before W1 (batches of 100) still judges. */
export const DESCRIBE_TASKS_BATCH_MAX = 100;
/** What the capture scripts send per call since LIVE-6 W1: 50 ARNs. 100 full task ARNs (~8.4k characters) exceed cmd.exe's
 *  8191-character command line -- an `aws.cmd` (the Windows test stub, a pip-installed CLI v1) cannot even be invoked with
 *  them; 50 (~4.2k) can. Every listed ARN is still described exactly once: a smaller batch changes how many calls describe
 *  the cluster, never what the listing must prove. The script tests pin it. */
export const DESCRIBE_TASKS_BATCH = 50;
/** The listing is taken inside capture-evidence, before the script writes capture.json: no more than this before it. */
export const CLUSTER_LISTING_WINDOW_MS = 15 * 60_000;

const TASK_ARN = /^arn:[a-z0-9-]+:ecs:[a-z0-9-]+:[0-9]{12}:task\/[A-Za-z0-9._\/-]+$/;
/** An ECS task id (a resource id, never player data): printed as it is, so the operator knows which task. */
const taskId = (arn: unknown): string => String(arn).split("/").pop() ?? String(arn);

export type ClusterListing =
  | { readonly ok: true; readonly tasks: readonly Record<string, Json>[]; readonly listedAt: number; readonly arns: number; readonly pages: Readonly<Record<string, number>> }
  | { readonly ok: false; readonly problem: string };

/**
 * The listing, or why it is not a COMPLETE one. Complete means, from the file alone:
 *  - format, cluster and a listing time;
 *  - exactly one listing per desired status (RUNNING, then STOPPED), each a chain of `list-tasks` pages numbered from 0, every
 *    page but the last answered with a next token (`more: true`) and the last without one (`more: false`) -- a listing
 *    that stopped early, or never ended, is not complete;
 *  - `task_count` = the distinct task ARNs listed (a task listed under both statuses while it changed is counted once);
 *  - `batches`: whole `describe-tasks` answers of 1..DESCRIBE_TASKS_BATCH_MAX (100) tasks each, none with a failure, that together describe
 *    EVERY listed ARN exactly once and nothing that was not listed.
 * Nothing is inferred from an absent field: no pages, no batches or a failure is incomplete, never "no task".
 */
export function readClusterListing(doc: Json, environment: string): ClusterListing {
  const d = obj(doc);
  const bad = (problem: string): ClusterListing => ({ ok: false, problem });
  if (d.format !== CLUSTER_TASKS_FORMAT) {
    return bad(Array.isArray(d.tasks) ? "cluster-tasks.json is a single desired-RUNNING answer (cut at 100, blind to draining tasks), not the paginated listing: run capture-evidence again" : `cluster-tasks.json is ${String(d.format)}, not ${CLUSTER_TASKS_FORMAT}`);
  }
  const cluster = expectedNames(environment, 1).cluster;
  if (d.cluster !== cluster) return bad(`cluster-tasks.json lists cluster ${String(d.cluster)}, not ${cluster}`);
  const listedAt = typeof d.listed_at === "string" ? Date.parse(d.listed_at) : NaN;
  if (!Number.isFinite(listedAt)) return bad("cluster-tasks.json names no listing time (listed_at)");
  if (!Array.isArray(d.listings)) return bad("cluster-tasks.json holds no listings");
  const listings = d.listings.map(obj);
  const statuses = listings.map((l) => String(l.desired_status));
  /* In this order: a task whose desired status moves to STOPPED during the capture is then still seen by the later listing. */
  if (listings.length !== CLUSTER_DESIRED_STATUSES.length || CLUSTER_DESIRED_STATUSES.some((s, i) => statuses[i] !== s)) {
    return bad(`cluster-tasks.json lists desired status [${statuses.join(", ")}], not exactly ${CLUSTER_DESIRED_STATUSES.join(" and ")}, in that order`);
  }
  const listed = new Set<string>();
  const pagesOf: Record<string, number> = {};
  for (const l of listings) {
    const status = String(l.desired_status);
    if (!Array.isArray(l.pages) || l.pages.length === 0) return bad(`the desired-${status} listing has no page`);
    const pages = l.pages.map(obj);
    for (let i = 0; i < pages.length; i += 1) {
      const p = pages[i];
      const last = i === pages.length - 1;
      if (p.page !== i) return bad(`the desired-${status} listing's page ${i} is numbered ${String(p.page)} (a page is missing or out of order)`);
      if (p.more !== !last) {
        return bad(last ? `the desired-${status} listing ends on a page that had a next token (the listing stopped early: truncated)` : `the desired-${status} listing's page ${i} had no next token, yet more pages follow`);
      }
      if (!Array.isArray(p.task_arns)) return bad(`the desired-${status} listing's page ${i} holds no task_arns`);
      for (const arn of p.task_arns) {
        if (typeof arn !== "string" || !TASK_ARN.test(arn)) return bad(`the desired-${status} listing's page ${i} holds ${JSON.stringify(arn)}, not a task ARN`);
        listed.add(arn);
      }
    }
    pagesOf[status] = pages.length;
  }
  if (d.task_count !== listed.size) return bad(`cluster-tasks.json counts ${String(d.task_count)} task(s), but its pages list ${listed.size} distinct ARN(s)`);
  if (!Array.isArray(d.batches)) return bad("cluster-tasks.json holds no describe-tasks batches");
  const tasks: Record<string, Json>[] = [];
  const described = new Map<string, number>();
  for (const [i, raw] of d.batches.entries()) {
    const b = obj(raw);
    if (!Array.isArray(b.tasks) || !Array.isArray(b.failures)) return bad(`describe-tasks batch ${i} is not a whole answer (tasks and failures)`);
    if (b.failures.length > 0) return bad(`describe-tasks batch ${i} failed for ${b.failures.length} task(s) (${b.failures.map((f) => `${taskId(obj(f).arn)}: ${String(obj(f).reason)}`).join(", ")}): the listing is incomplete`);
    if (b.tasks.length === 0 || b.tasks.length > DESCRIBE_TASKS_BATCH_MAX) return bad(`describe-tasks batch ${i} describes ${b.tasks.length} task(s), not 1-${DESCRIBE_TASKS_BATCH_MAX}`);
    for (const t of b.tasks.map(obj)) {
      const arn = String(t.taskArn);
      described.set(arn, (described.get(arn) ?? 0) + 1);
      tasks.push(t);
    }
  }
  const undescribed = [...listed].filter((arn) => !described.has(arn));
  const unlisted = [...described.keys()].filter((arn) => !listed.has(arn));
  const twice = [...described].filter(([, n]) => n > 1).map(([arn]) => arn);
  if (undescribed.length > 0) return bad(`${undescribed.length} listed task(s) were never described (${undescribed.slice(0, 5).map(taskId).join(", ")}${undescribed.length > 5 ? ", ..." : ""}): the listing is incomplete`);
  if (unlisted.length > 0) return bad(`describe-tasks answered ${unlisted.length} task(s) no page listed (${unlisted.slice(0, 5).map(taskId).join(", ")})`);
  if (twice.length > 0) return bad(`task(s) described more than once (${twice.slice(0, 5).map(taskId).join(", ")}): each listed task is described exactly once`);
  return { ok: true, tasks, listedAt, arns: listed.size, pages: pagesOf };
}

/**
 * NOTHING BESIDE IT, from the COMPLETE cluster listing (desired RUNNING and desired STOPPED, every page, every batch).
 * A STOPPED task is terminal and cannot act (ECS reports it for a while; the certifier task ends that way). Every other
 * task must be a pool service's settled task: group `service:<pool's service>`, desired RUNNING, lastStatus RUNNING, on
 * the service's own task definition. Anything else refuses the certification, by class:
 *   outside the services   a `run-task` of a pool's definition beside its service would fence it ("Rollout");
 *   draining / stopping    desired STOPPED but not yet STOPPED -- still running under SIGTERM (stopTimeout 120 s);
 *   starting               desired RUNNING, not yet RUNNING (PROVISIONING / PENDING / ACTIVATING);
 *   replacement incomplete a service task on a task definition other than the service's.
 * And the listing really is the cluster's: its settled service tasks are exactly the ones `running-tasks.json` holds.
 * Every described entry is judged -- the ARN deduplication never merges two answers into one.
 */
export function checkClusterTasks(clusterDoc: Json, expect: PrerequisiteExpect, runningDoc: Json, servicesDoc: Json = null, captureDoc: Json = null): Check[] {
  const names = expectedNames(expect.environment, 1);
  const listing = readClusterListing(clusterDoc, expect.environment);
  const captured = Date.parse(String(obj(captureDoc).captured_at));
  const completeCheck = listing.ok
    ? judge(
        "prerequisite: the cluster listing is complete",
        Number.isFinite(captured) && listing.listedAt <= captured && captured - listing.listedAt <= CLUSTER_LISTING_WINDOW_MS,
        `${listing.arns} task(s): desired RUNNING ${String(listing.pages.RUNNING)} page(s), desired STOPPED ${String(listing.pages.STOPPED)} page(s), every one described`,
        Number.isFinite(captured)
          ? `the listing (${new Date(listing.listedAt).toISOString()}) is not this capture's (capture.json ${String(obj(captureDoc).captured_at)}; at most ${CLUSTER_LISTING_WINDOW_MS / 60_000} min before it): run capture-evidence again`
          : "capture.json names no capture time to bind the listing to",
      )
    : fail("prerequisite: the cluster listing is complete", listing.problem);
  if (!listing.ok) return [completeCheck, fail("prerequisite: no task beside the services", `the cluster listing is incomplete: ${listing.problem} (a failed, truncated or partial listing proves nothing)`)];

  const services = new Map<string, string | null>();
  for (const pool of expect.pools) services.set(`service:${names.service(pool)}`, str(serviceOf(servicesDoc, expect.environment, pool)?.taskDefinition));
  const outside: string[] = [];
  const draining: string[] = [];
  const starting: string[] = [];
  const replacing: string[] = [];
  const settled = new Set<string>();
  let stopped = 0;
  for (const t of listing.tasks) {
    if (t.lastStatus === "STOPPED") {
      stopped += 1;
      continue;
    }
    const where = `${taskId(t.taskArn)} ${String(t.group)} ${String(t.taskDefinitionArn)} (${String(t.lastStatus)}/desired ${String(t.desiredStatus)})`;
    const group = String(t.group);
    if (!services.has(group)) outside.push(where);
    else if (t.desiredStatus !== "RUNNING") draining.push(where);
    else if (t.lastStatus !== "RUNNING") starting.push(where);
    else if (services.get(group) === null || t.taskDefinitionArn !== services.get(group)) replacing.push(`${where}, not the service's ${String(services.get(group))}`);
    else settled.add(String(t.taskArn));
  }
  const serviceArns = arr(obj(runningDoc).tasks).map((t) => String(obj(t).taskArn));
  const unlisted = serviceArns.filter((arn) => !settled.has(arn));
  const unexplained = [...settled].filter((arn) => !serviceArns.includes(arn));
  const problems = [
    outside.length === 0 ? null : `task(s) outside the services: ${outside.join("; ")} (a pool's definition run beside its service fences it)`,
    draining.length === 0 ? null : `task(s) draining or stopping: ${draining.join("; ")} (wait until they are STOPPED, then capture again)`,
    starting.length === 0 ? null : `task(s) starting: ${starting.join("; ")}`,
    replacing.length === 0 ? null : `replacement incomplete: ${replacing.join("; ")}`,
    serviceArns.length > 0 && unlisted.length === 0 ? null : `the cluster listing is incomplete: it lacks ${unlisted.length || "every"} service task(s) running-tasks.json holds (a failed or empty listing proves nothing)`,
    unexplained.length === 0 ? null : `the cluster lists service task(s) running-tasks.json does not hold: ${unexplained.map(taskId).join(", ")} (the captures disagree: capture again)`,
  ].filter((p): p is string => p !== null);
  return [
    completeCheck,
    judge(
      "prerequisite: no task beside the services",
      problems.length === 0,
      `every one of the cluster's ${listing.tasks.length - stopped} live task(s) is a pool service's settled task (${stopped} STOPPED)`,
      problems.join("; "),
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
