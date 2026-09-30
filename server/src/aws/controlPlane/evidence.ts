// server/src/aws/controlPlane/evidence.ts
//
// ==================================================================
//  LIVE-6 L6-2: THE MULTI-POOL CONTROL PLANE, JUDGED FROM EVIDENCE -- PURE CHECKS OVER THE READ-ONLY AWS CLI CAPTURES
// ==================================================================
//
// L5-8's rule stands: the server carries no ECS / ELB / CloudFront / EC2 SDK. The control plane is judged from the JSON the
// read-only AWS CLI prints, captured by infra/aws/scripts/capture-evidence.{sh,ps1}. This module holds the checks the
// multi-pool layout (L6-2) adds, shared by `awsDeploy verify` (the deploy verifier) and `gamesDoctor aws flip` /
// `retire-check` (the operator's flip preflight and retirement proof). Nothing here reads AWS, writes anything or holds a
// credential: every function is a pure judgement of a parsed document, or a read of a file in the evidence directory.
//
// WHAT IS CHECKED (each answer names what it saw):
//   manifest             the capture's own statement (`manifest.json`): which environment and pools, and WHEN -- a
//                        preflight refuses evidence older than its bound (the world may have moved since);
//   target groups        one per pool, named gs-<env>-<pool>, readiness `/gs/readyz` -> 200, ip targets;
//   target health        a pool with one task: exactly one target, `healthy` (a non-primary router is healthy too: its
//                        readiness is 200 `non-primary`); a drained pool: no target at all;
//   listener rules       the `/gs*` default forwards to the PRIMARY's target group; each pool's EXACT trusted ws_path
//                        (the runtime document v2's `routes`) forwards to THAT pool's group, at a priority before the
//                        default; and -- the shadowing proof -- for every pool path and every /gs path the FIRST rule
//                        that matches it, in the ALB's own order, is the intended one;
//   services             each behind its OWN target group (never another pool's), settled (no deployment in progress);
//   identity layout      every ACTIVE revision of each pool's task-definition family -- every possible circuit-breaker
//                        rollback target -- declares the L6-4 identity layout (L6-4 §12.3: one-way);
//   role changes         after a flip, each pool's service shows a task that STOPPED with the role-change exit (5) at or
//                        after the flip, a running task started after it, and no task that stopped in that window with
//                        a loss (3) or a store restart (4) -- those stay abnormal (L6-5B).

import * as fs from "fs";
import * as path from "path";

export interface Check {
  readonly name: string;
  readonly status: "pass" | "fail" | "skipped";
  readonly detail: string;
}

const pass = (name: string, detail: string): Check => ({ name, status: "pass", detail });
const fail = (name: string, detail: string): Check => ({ name, status: "fail", detail });
const judge = (name: string, ok: boolean, good: string, bad: string): Check => (ok ? pass(name, good) : fail(name, bad));

type Json = unknown;
const obj = (value: Json): Record<string, Json> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json>) : {});
const arr = (value: Json): Json[] => (Array.isArray(value) ? value : []);
const str = (value: Json): string | null => (typeof value === "string" ? value : null);

export const EVIDENCE_MANIFEST_FORMAT = "18COSMOS/EVIDENCE/v1";

/** The role-change exit (L6-1 `EXIT_ROLE_CHANGED`), and the two exits a flip must never show (loss, store restart). */
export const EXIT_ROLE_CHANGED = 5;
export const ABNORMAL_EXITS: readonly number[] = Object.freeze([3, 4]);
/** L6-4 §12.3: the identity-table layout every AWS-mode image (and every rollback target) must read. */
export const IDENTITY_LAYOUT_MIN = 2;
export const IDENTITY_LAYOUT_TAG = "gs:identity-layout";

/** The evidence files the multi-pool checks read (beside L5-8's). */
export const POOL_EVIDENCE_FILES = Object.freeze({
  manifest: "manifest.json",
  targetGroups: "target-groups.json",
  targetHealth: (pool: string) => `target-health-${pool}.json`,
  stoppedTasks: (pool: string) => `stopped-tasks-${pool}.json`,
  runningTasks: (pool: string) => `running-tasks-${pool}.json`,
  revisionsDir: (pool: string) => `task-definition-revisions-${pool}`,
  services: "services.json",
  listenerRules: "listener-rules.json",
});

export const names = (environment: string) => ({
  cluster: `gs-${environment}`,
  service: (pool: string) => `gs-${environment}-${pool}`,
  targetGroup: (pool: string) => `gs-${environment}-${pool}`,
});

/** A time from the AWS CLI (ISO-8601 by default in CLI v2; epoch seconds in some configurations), in ms. */
export function cliTime(value: Json): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Reading the directory                                                */
/* ------------------------------------------------------------------ */

export type EvidenceRead = { readonly ok: true; readonly value: Json } | { readonly ok: false; readonly check: Check };

/** One evidence file (a missing or unparseable file is a failure, never a skip). */
export function readEvidence(dir: string, file: string): EvidenceRead {
  try {
    /* Windows PowerShell 5.1 writes UTF-8 with a byte-order mark; JSON.parse does not accept one. */
    return { ok: true, value: JSON.parse(fs.readFileSync(path.join(dir, file), "utf8").replace(/^﻿/, "")) as Json };
  } catch (error) {
    return { ok: false, check: fail(`evidence ${file}`, `missing or not JSON (${error instanceof Error ? error.message.slice(0, 200) : String(error)})`) };
  }
}

/** Every revision document of a pool's family (`task-definition-revisions-<pool>/*.json`). */
export function readRevisions(dir: string, pool: string): { readonly ok: true; readonly docs: Json[] } | { readonly ok: false; readonly check: Check } {
  const where = path.join(dir, POOL_EVIDENCE_FILES.revisionsDir(pool));
  let files: string[];
  try {
    files = fs.readdirSync(where).filter((f) => f.endsWith(".json")).sort();
  } catch (error) {
    return { ok: false, check: fail(`evidence ${POOL_EVIDENCE_FILES.revisionsDir(pool)}/`, `missing (${error instanceof Error ? error.message.slice(0, 200) : String(error)})`) };
  }
  const docs: Json[] = [];
  for (const file of files) {
    const read = readEvidence(where, file);
    if (!read.ok) return { ok: false, check: read.check };
    docs.push(read.value);
  }
  return { ok: true, docs };
}

/* ------------------------------------------------------------------ */
/* The manifest                                                         */
/* ------------------------------------------------------------------ */

export function checkManifest(doc: Json, expect: { readonly environment: string; readonly pools: readonly string[]; readonly now: number; readonly maxAgeMs: number | null }): Check[] {
  const m = obj(doc);
  const at = cliTime(m.captured_at);
  const pools = arr(m.pools).map(String);
  const checks: Check[] = [
    judge("evidence manifest", m.format === EVIDENCE_MANIFEST_FORMAT && m.environment === expect.environment, `${EVIDENCE_MANIFEST_FORMAT}, ${expect.environment}`, `format ${String(m.format)}, environment ${String(m.environment)} (expected ${EVIDENCE_MANIFEST_FORMAT}, ${expect.environment})`),
    judge("evidence manifest: pools", expect.pools.every((p) => pools.includes(p)), `captured ${pools.join(", ")}`, `captured [${pools.join(", ")}], needed [${expect.pools.join(", ")}]`),
  ];
  if (expect.maxAgeMs !== null) {
    const age = at === null ? null : expect.now - at;
    checks.push(judge("evidence manifest: fresh", age !== null && age >= -60_000 && age <= expect.maxAgeMs, `captured ${age === null ? "?" : Math.round(age / 1000)} s ago`, at === null ? "no capture time" : `captured ${Math.round((age as number) / 1000)} s ago; recapture (at most ${Math.round(expect.maxAgeMs / 1000)} s old)`));
  }
  return checks;
}

/* ------------------------------------------------------------------ */
/* Target groups and their health                                       */
/* ------------------------------------------------------------------ */

/** Each pool's target group (`aws elbv2 describe-target-groups --names ...`): its ARN, or failures. */
export function checkPoolTargetGroups(doc: Json, expect: { readonly environment: string; readonly pools: readonly string[] }): { readonly checks: Check[]; readonly arns: ReadonlyMap<string, string> } {
  const groups = arr(obj(doc).TargetGroups).map(obj);
  const checks: Check[] = [];
  const arns = new Map<string, string>();
  for (const pool of expect.pools) {
    const name = names(expect.environment).targetGroup(pool);
    const g = groups.find((x) => x.TargetGroupName === name);
    if (g === undefined) {
      checks.push(fail(`target group ${name}`, "not in the evidence"));
      continue;
    }
    const arn = str(g.TargetGroupArn);
    if (arn !== null) arns.set(pool, arn);
    const problems = [
      g.HealthCheckPath === "/gs/readyz" ? null : `health check path ${String(g.HealthCheckPath)} (readiness, not liveness)`,
      obj(g.Matcher).HttpCode === "200" ? null : `matcher ${String(obj(g.Matcher).HttpCode)}`,
      g.TargetType === "ip" ? null : `target type ${String(g.TargetType)}`,
      arn === null ? "no ARN" : null,
    ].filter((p): p is string => p !== null);
    checks.push(judge(`target group ${name}`, problems.length === 0, "/gs/readyz -> 200, ip targets", problems.join("; ")));
  }
  return { checks, arns };
}

/** A pool's target health (`aws elbv2 describe-target-health`): one healthy target (desired 1), none (desired 0). */
export function checkTargetHealth(pool: string, doc: Json, desired: 0 | 1): Check {
  const targets = arr(obj(doc).TargetHealthDescriptions).map(obj);
  const states = targets.map((t) => String(obj(t.TargetHealth).State));
  if (desired === 0) return judge(`target health ${pool}`, targets.length === 0, "no target (drained)", `${targets.length} target(s) [${states.join(", ")}] on a drained pool`);
  return judge(`target health ${pool}`, targets.length === 1 && states[0] === "healthy", "one target, healthy", `${targets.length} target(s) [${states.join(", ")}]: expected exactly one healthy`);
}

/* ------------------------------------------------------------------ */
/* Listener rules: routing and shadowing                                */
/* ------------------------------------------------------------------ */

/** An ALB path pattern (`*` any run, `?` one character; case-sensitive; the whole path, never the query). */
export function albPatternMatches(pattern: string, pathname: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return re.test(pathname);
}

interface Rule {
  readonly priority: number;
  readonly paths: readonly string[];
  readonly target: string | null;
  readonly isDefault: boolean;
  readonly other: boolean;
}

function parseRules(doc: Json): Rule[] {
  return arr(obj(doc).Rules)
    .map(obj)
    .map((r) => {
      const conditions = arr(r.Conditions).map(obj);
      const paths = conditions.filter((c) => c.Field === "path-pattern").flatMap((c) => arr(obj(c.PathPatternConfig).Values ?? c.Values).map(String));
      const forward = arr(r.Actions).map(obj).find((a) => a.Type === "forward");
      const target = str(forward?.TargetGroupArn) ?? str(obj(arr(obj(forward?.ForwardConfig).TargetGroups)[0]).TargetGroupArn);
      const isDefault = r.IsDefault === true || r.Priority === "default";
      return { priority: isDefault ? Number.POSITIVE_INFINITY : Number(r.Priority), paths, target, isDefault, other: conditions.some((c) => c.Field !== "path-pattern") };
    })
    .sort((a, b) => a.priority - b.priority);
}

/** The /gs paths the shadowing proof walks besides every pool's own path. */
export const GS_PROBE_PATHS: readonly string[] = Object.freeze(["/gs", "/gs/", "/gs/healthz", "/gs/readyz", "/gs/api/session", "/gs/ws", "/gs/p", "/gs/p/"]);

/**
 * The listener's rules (`aws elbv2 describe-rules`): `/gs*` -> the primary's target group; each pool's exact ws_path ->
 * its own; and for every path a client may use, the FIRST matching rule in the ALB's order is the intended one.
 */
export function checkPoolListenerRules(doc: Json, expect: { readonly primary: string; readonly routes: Readonly<Record<string, string>>; readonly targetGroups: ReadonlyMap<string, string> }): Check[] {
  const rules = parseRules(doc);
  const checks: Check[] = [];
  const gs = rules.filter((r) => r.paths.includes("/gs*"));
  const primaryGroup = expect.targetGroups.get(expect.primary) ?? null;
  if (gs.length !== 1) checks.push(fail("ALB /gs* rule", `${gs.length} listener rules match /gs*`));
  else checks.push(judge("ALB /gs* rule", primaryGroup !== null && gs[0].target === primaryGroup, `/gs* -> ${expect.primary}'s target group`, `/gs* forwards to ${gs[0].target}, not the primary ${expect.primary}'s ${primaryGroup}`));
  for (const [pool, wsPath] of Object.entries(expect.routes)) {
    const own = rules.filter((r) => !r.isDefault && r.paths.length === 1 && r.paths[0] === wsPath);
    const group = expect.targetGroups.get(pool) ?? null;
    if (own.length !== 1) {
      checks.push(fail(`ALB rule ${wsPath}`, `${own.length} rules with exactly the path ${wsPath}`));
      continue;
    }
    checks.push(judge(`ALB rule ${wsPath}`, group !== null && own[0].target === group && (gs.length !== 1 || own[0].priority < gs[0].priority), `${wsPath} -> ${pool}'s target group, priority ${own[0].priority}`, `${wsPath} forwards to ${own[0].target} (${pool}'s is ${group}) at priority ${own[0].priority}${gs.length === 1 && own[0].priority >= gs[0].priority ? " -- AFTER /gs*, which shadows it" : ""}`));
  }
  /* The shadowing proof: in the ALB's order, which rule answers each path. */
  const intended = new Map<string, string | null>();
  for (const [pool, wsPath] of Object.entries(expect.routes)) intended.set(wsPath, expect.targetGroups.get(pool) ?? null);
  for (const probe of GS_PROBE_PATHS) if (!intended.has(probe)) intended.set(probe, primaryGroup);
  const shadowed: string[] = [];
  for (const [probe, want] of intended) {
    const first = rules.find((r) => !r.isDefault && r.paths.some((p) => albPatternMatches(p, probe)));
    if (first === undefined || first.target !== want || first.other) shadowed.push(`${probe} is answered by ${first === undefined ? "the default action" : `priority ${first.priority} (${first.paths.join(", ")}) -> ${first.target}${first.other ? " (with a non-path condition)" : ""}`}`);
  }
  checks.push(judge("ALB: no rule shadows another pool", shadowed.length === 0, `every pool path and ${GS_PROBE_PATHS.length} /gs paths reach their intended target group first`, shadowed.join("; ")));
  return checks;
}

/* ------------------------------------------------------------------ */
/* Services                                                             */
/* ------------------------------------------------------------------ */

export interface ServiceView {
  readonly desired: number | null;
  readonly running: number | null;
  readonly pending: number | null;
  readonly settled: boolean;
  readonly targetGroups: readonly string[];
}

export function serviceOf(doc: Json, environment: string, pool: string): ServiceView | null {
  const s = arr(obj(doc).services).map(obj).find((x) => x.serviceName === names(environment).service(pool));
  if (s === undefined) return null;
  const running = str(s.taskDefinition);
  const deploying = arr(s.deployments).map((d) => str(obj(d).taskDefinition)).filter((t) => t !== running);
  const rolloutOpen = arr(s.deployments).map(obj).some((d) => d.rolloutState === "IN_PROGRESS");
  return {
    desired: typeof s.desiredCount === "number" ? s.desiredCount : null,
    running: typeof s.runningCount === "number" ? s.runningCount : null,
    pending: typeof s.pendingCount === "number" ? s.pendingCount : null,
    settled: running !== null && deploying.length === 0 && !rolloutOpen,
    targetGroups: arr(s.loadBalancers).map((b) => String(obj(b).targetGroupArn)),
  };
}

/** Each pool's service behind its OWN target group, and settled (no deployment in progress). */
export function checkPoolServices(doc: Json, expect: { readonly environment: string; readonly pools: readonly string[]; readonly targetGroups: ReadonlyMap<string, string> }): Check[] {
  const checks: Check[] = [];
  for (const pool of expect.pools) {
    const label = `service ${names(expect.environment).service(pool)}`;
    const s = serviceOf(doc, expect.environment, pool);
    if (s === null) {
      checks.push(fail(`${label}: exists`, "not in the evidence"));
      continue;
    }
    const own = expect.targetGroups.get(pool) ?? null;
    checks.push(judge(`${label}: its own target group`, own !== null && s.targetGroups.length === 1 && s.targetGroups[0] === own, `${pool}'s target group`, `load balancers [${s.targetGroups.join(", ")}], expected [${own}]`));
    checks.push(judge(`${label}: no deployment in progress`, s.settled, "settled", "a deployment is in progress: wait for it to settle (a flip or retirement never runs beside one)"));
  }
  return checks;
}

/* ------------------------------------------------------------------ */
/* The one-way identity layout (L6-4 §12.3)                             */
/* ------------------------------------------------------------------ */

/** Every ACTIVE revision of a pool's family -- every possible rollback target -- declares identity layout >= 2. */
export function checkIdentityLayout(pool: string, revisions: readonly Json[]): Check {
  const label = `identity layout ${pool} (every rollback target)`;
  if (revisions.length === 0) return fail(label, "no ACTIVE revision in the evidence");
  const bad: string[] = [];
  for (const doc of revisions) {
    const td = obj(obj(doc).taskDefinition);
    const arn = str(td.taskDefinitionArn) ?? "?";
    const status = str(td.status);
    if (status !== null && status !== "ACTIVE") continue;
    const tag = arr(obj(doc).tags).map(obj).find((t) => t.key === IDENTITY_LAYOUT_TAG);
    const layout = tag === undefined ? null : Number(tag.value);
    if (layout === null || !Number.isSafeInteger(layout) || layout < IDENTITY_LAYOUT_MIN) bad.push(`${arn} (${tag === undefined ? "no tag" : `layout ${String(tag.value)}`})`);
  }
  return judge(label, bad.length === 0, `${revisions.length} ACTIVE revision(s), each ${IDENTITY_LAYOUT_TAG} >= ${IDENTITY_LAYOUT_MIN}`, `an image older than L6-4's identity layout could be rolled back to: ${bad.join(", ")} -- deregister those revisions before any AWS-mode task runs`);
}

/* ------------------------------------------------------------------ */
/* Role changes after a flip                                            */
/* ------------------------------------------------------------------ */

interface TaskView {
  readonly arn: string;
  readonly group: string | null;
  readonly exitCode: number | null;
  readonly startedAt: number | null;
  readonly stoppedAt: number | null;
}

function tasksOf(doc: Json): TaskView[] {
  return arr(obj(doc).tasks)
    .map(obj)
    .map((t) => {
      const container = arr(t.containers).map(obj).find((c) => c.name === "game-server") ?? obj(arr(t.containers)[0]);
      return { arn: String(t.taskArn), group: str(t.group), exitCode: typeof container.exitCode === "number" ? container.exitCode : null, startedAt: cliTime(t.startedAt), stoppedAt: cliTime(t.stoppedAt) };
    });
}

/**
 * After a flip at `since`: this pool's service shows a task that stopped with the role-change exit at or after it, a
 * RUNNING task started after that stop (the replacement), and no task that stopped in the window with a loss (3) or a store
 * restart (4) -- those remain abnormal even inside a planned flip.
 */
export function checkRoleChange(pool: string, environment: string, stopped: Json, running: Json, since: number): Check[] {
  const group = `service:${names(environment).service(pool)}`;
  const mine = (t: TaskView) => t.group === null || t.group === group;
  const stops = tasksOf(stopped).filter((t) => mine(t) && t.stoppedAt !== null && t.stoppedAt >= since);
  const roleChange = stops.filter((t) => t.exitCode === EXIT_ROLE_CHANGED).sort((a, b) => (a.stoppedAt as number) - (b.stoppedAt as number));
  const abnormal = stops.filter((t) => t.exitCode !== null && ABNORMAL_EXITS.includes(t.exitCode));
  const replacement = tasksOf(running).filter((t) => mine(t) && t.startedAt !== null && roleChange.length > 0 && (t.startedAt as number) >= (roleChange[0].stoppedAt as number));
  return [
    judge(`role change ${pool}: exit ${EXIT_ROLE_CHANGED}`, roleChange.length >= 1, `${roleChange.length} task(s) stopped with exit ${EXIT_ROLE_CHANGED} after the flip`, `no task of ${pool} stopped with exit ${EXIT_ROLE_CHANGED} after the flip (stops seen: [${stops.map((t) => String(t.exitCode)).join(", ")}])`),
    judge(`role change ${pool}: no loss`, abnormal.length === 0, "no exit 3 / 4 in the flip window", `${abnormal.length} task(s) stopped with a loss or store restart (${abnormal.map((t) => `exit ${t.exitCode}`).join(", ")}) -- abnormal even in a planned flip`),
    judge(`role change ${pool}: replacement running`, replacement.length === 1, "one replacement task running, started after the role-change stop", `${replacement.length} running task(s) started after the role-change stop`),
  ];
}

/* ------------------------------------------------------------------ */
/* Drained (L5-8's drain-first rule)                                    */
/* ------------------------------------------------------------------ */

/** A pool drained by `drain-pool`: desired 0, running 0, pending 0 (ECS 0/100 alone is not proof). */
export function checkDrained(doc: Json, environment: string, pool: string): Check {
  const s = serviceOf(doc, environment, pool);
  if (s === null) return fail(`drained ${pool}`, "its service is not in the evidence");
  return judge(`drained ${pool}`, s.desired === 0 && s.running === 0 && s.pending === 0 && s.settled, "desired 0, running 0, pending 0", `desired ${s.desired}, running ${s.running}, pending ${s.pending}${s.settled ? "" : ", a deployment in progress"}: run infra/aws/scripts/drain-pool first`);
}

/** Which of a set of checks failed (for a one-line verdict). */
export const failures = (checks: readonly Check[]): Check[] => checks.filter((c) => c.status === "fail");
