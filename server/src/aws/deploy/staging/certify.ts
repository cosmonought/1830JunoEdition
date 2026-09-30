// server/src/aws/deploy/staging/certify.ts
//
// ==================================================================
//  LIVE-6 L6-6: THE STAGING CERTIFICATION -- ONE REGISTRY OF GATES, ONE VERDICT LAW, ONE DETERMINISTIC REPORT
// ==================================================================
//
// `awsDeploy stage-cert certify` evaluates every gate below over ONE run's evidence directory (`evidence.ts`) and the
// live, READ-ONLY L5-8 verification (`collectVerification`: the same code as `awsDeploy verify`). It deploys nothing and
// writes nothing but the report files in the evidence directory.
//
//   1  prerequisite    the deployment is settled and known, and unchanged since `stage-cert prerequisite` (§1)
//   2  drain           drain -> zero running/pending -> apply/start, from ECS timestamps (replacement scenario; §2)
//   3  iam             the task role's LeadingKeys exclusions inside real transactions, attributed to the task role (§3)
//   4  transactions    the real service's conditional / conflict / same-token semantics, on disposable items (§4)
//   5  proxy-hops      GS_TRUSTED_PROXY_HOPS=2 through the deployed edge (§5)
//   6  query-strings   cp, cr, cb -- and every other parameter -- unchanged through CloudFront (§6)
//   7  websocket       the socket's own path carries cp; an idle socket survives client -> CloudFront -> ALB -> server (§7)
//   8  kms             the configured keys sign a disposable digest, verified, below 3 s (§8)
//   9  terraform       the ledger and app plans: versions, lock, exit status, nothing destroyed, services gated (§9)
//   10 evidence        the package: identities, the certifier task's own record, no secret anywhere (§10)
//   L6-4 (L6-6R)       generation, identity, review, rollback, restore-quiet, restore-fence (`recovery.ts`)
//   LIVE-6 final convergence (`drills.ts`): alarms (L6-5B's contract, every scenario); generation-gate and restore-alarms
//                      (restore drill); flip and flip-alarms (flip drill); relayer-rotation (rotation drill)
//
// THE VERDICT LAW. A required gate passes only when it has at least one check and every check passed. Missing evidence
// is a FAILED check, never a skip; a SKIP from the verifier is a failure here unless it is explicitly replaced (the ledger
// half by `verify-ledger.json`); a gate not required by the scenario says so in words and is neither PASS nor FAIL.
// The certification is PASS only if every required gate passed.
//
// EXTENSION (L6-1 routing, L6-5A telemetry, ...). A later branch adds a gate by appending a `StagingGate` to
// `STAGING_GATES` (or passing `extraGates`), and -- when it needs an active probe -- a section in a probe record
// (`sections.<name>` of probe-task-role.json / probe-edge.json, or a new probe-<name>.json). Nothing here is redesigned:
// the registry, the verdict law, the report and the manifest take it as it is.

import * as fs from "fs";
import * as path from "path";

import type { AwsStartup } from "../../runtime/awsMain";
import type { Check } from "../deployVerify";
import { EVIDENCE_FILES } from "../deployVerify";
import { judgeDrain, READ_ONLY_DRAIN_NOTE } from "./drain";
import { judgeEdgeTarget, judgeQueryProbe, judgeWsAnnouncement, judgeWsIdle } from "./edgeProbe";
import {
  allPass,
  arr,
  CERTIFICATION_FORMAT,
  checkEnvelope,
  EVIDENCE,
  fail,
  judge,
  manifestOf,
  num,
  obj,
  pass,
  PREREQUISITE_FORMAT,
  readEvidence,
  readEvidenceText,
  recordFromLog,
  stableStringify,
  str,
  VERIFY_RECORD_FORMAT,
  writeRecord,
} from "./evidence";
import { IAM_PROBE_IDS, judgeIamProbe } from "./iamProbe";
import { judgeKmsProbe } from "./kmsProbe";
import { accountOf, judgeAlarmsGate, judgeFlipAlarmDrill, judgeFlipDrill, judgeGenerationGateRecord, judgeRestoreAlarmDrill, judgeRotationDrill, flipRecordOf, flipWindowOf } from "./drills";
import { adoptionOf, certifierImage, generationMeasurement, judgeGeneration, judgeIdentityRecovery, judgeReviews, judgeRestoreFencing, judgeRestoreQuiet, judgeRollback, NOT_INTEGRATED, type GenerationEvidence, type HeartbeatEvidence } from "./recovery";
import { buildIdOf, checkClusterTasks, checkRunningTasks, checkServicesSettled, checkTargetHealth, readClusterListing } from "./prerequisite";
import { STACKS, TERRAFORM_FILES, judgeTerraformStack } from "./terraformPlan";
import { judgeTransactionProbe } from "./transactionProbe";

/** LIVE-6 final convergence: `flip-drill` (L6-2's planned flip, L6-5B's suppression) and `relayer-rotation-drill` (L6-2 /
 *  L6-7's address rotation gate) join L6-6's three scenarios. */
export type Scenario = "read-only" | "replacement" | "restore-drill" | "flip-drill" | "relayer-rotation-drill";
export const SCENARIOS: readonly Scenario[] = Object.freeze(["read-only", "replacement", "restore-drill", "flip-drill", "relayer-rotation-drill"]);

/** Clocks differ (the operator's machine, the certifier task, Terraform's host): comparisons allow this much. */
export const CLOCK_SKEW_MS = 120_000;

/** What the prerequisite identifies: the deployment every probe must have run against. */
export interface DeploymentIdentity {
  readonly task_definitions: Readonly<Record<string, string | null>>;
  readonly running_tasks: Readonly<Record<string, readonly string[]>>;
  readonly build_id: string | null;
}

export interface PrerequisiteResult {
  readonly checks: Check[];
  readonly identity: DeploymentIdentity;
  readonly startup: AwsStartup;
  readonly running: ReadonlyMap<string, readonly Record<string, unknown>[]>;
  /** L6-6P: when the complete cluster listing was taken (null: no complete listing -- the prerequisite already FAILS). */
  readonly clusterListedAt?: number | null;
}

/* ------------------------------------------------------------------ */
/* §1 The prerequisite                                                  */
/* ------------------------------------------------------------------ */

/**
 * The prerequisite over the verifier's checks (already collected, live) and the evidence directory's captures. A SKIP
 * from the verifier is a failure except the ledger half in the two-account form, replaced by `verify-ledger.json`.
 */
export function prerequisiteChecks(
  dir: string,
  verification: { readonly checks: readonly Check[]; readonly startup: AwsStartup },
  expect: { readonly run: string; readonly environment: string; readonly generation: number; readonly primaryPool: string; readonly pools: readonly string[]; readonly part: "app" | "all" },
): PrerequisiteResult {
  const checks: Check[] = [];
  for (const c of verification.checks) {
    if (c.status !== "skipped") {
      checks.push({ ...c, name: `verify: ${c.name}` });
      continue;
    }
    if (c.name === "ledger table: PITR and TTL" && expect.part === "app") {
      const ledger = readEvidence(dir, EVIDENCE.verifyLedger, { ownRecord: true });
      if (!ledger.ok) checks.push(fail("verify: ledger half", `${ledger.problem} (two-account form: \`verify --part ledger ... --record ${EVIDENCE.verifyLedger}\` with the ledger account's credentials, or --part all)`));
      else {
        const r = obj(ledger.value);
        checks.push(
          judge(
            "verify: ledger half",
            r.format === VERIFY_RECORD_FORMAT && r.part === "ledger" && r.run_id === expect.run && r.environment === expect.environment && r.generation === expect.generation && r.verdict === "PASS" && allPass(arr(r.checks).map(obj) as unknown as Check[]),
            `${EVIDENCE.verifyLedger}: PITR, TTL and APPGEN verified with the ledger account's credentials for ${expect.run} (${String(r.at)})`,
            `${EVIDENCE.verifyLedger}: ${String(r.format)} ${String(r.part)} run ${String(r.run_id)} ${String(r.environment)} g${String(r.generation)} verdict ${String(r.verdict)} (\`verify --part ledger ... --run-id ${expect.run} --record ...\`)`,
          ),
        );
      }
      continue;
    }
    if (c.name === "KMS signing keys") {
      checks.push(fail("verify: KMS signing keys", "escrow is null: the staging certification needs the escrow configuration (its KMS keys are a certified gate)"));
      continue;
    }
    checks.push(fail(`verify: ${c.name}`, `skipped by the verifier (${c.detail}): a skip is not evidence`));
  }

  const read = (file: string) => readEvidence(dir, file);
  const services = read(EVIDENCE_FILES.services);
  const tasks = read(EVIDENCE.runningTasks);
  const cluster = read(EVIDENCE.clusterTasks);
  const health = read(EVIDENCE.targetHealth);
  const prereq = { environment: expect.environment, pools: expect.pools, primaryPool: expect.primaryPool };
  let running: ReadonlyMap<string, readonly Record<string, unknown>[]> = new Map();
  if (!services.ok) checks.push(fail("prerequisite: services", services.problem));
  else checks.push(...checkServicesSettled(services.value, prereq));
  if (!services.ok || !tasks.ok) checks.push(fail("prerequisite: running tasks", tasks.ok ? "services.json is missing" : tasks.problem));
  else {
    const r = checkRunningTasks(tasks.value, services.value, prereq);
    checks.push(...r.checks);
    running = r.running;
  }
  const capture = read(EVIDENCE.capture);
  checks.push(
    ...(cluster.ok
      ? checkClusterTasks(cluster.value, prereq, tasks.ok ? tasks.value : null, services.ok ? services.value : null, capture.ok ? capture.value : null)
      : [fail("prerequisite: the cluster listing is complete", cluster.problem), fail("prerequisite: no task beside the services", cluster.problem)]),
  );
  checks.push(...(health.ok ? checkTargetHealth(health.value, running.get(expect.primaryPool) ?? []) : [fail("prerequisite: target health", health.problem)]));

  const taskDefinitions: Record<string, string | null> = {};
  const runningArns: Record<string, readonly string[]> = {};
  const serviceList = services.ok ? arr(obj(services.value).services).map(obj) : [];
  for (const pool of expect.pools) {
    taskDefinitions[pool] = str(serviceList.find((s) => String(s.serviceName).endsWith(`-${pool}`))?.taskDefinition);
    runningArns[pool] = (running.get(pool) ?? []).map((t) => String(t.taskArn)).sort();
  }
  const primaryTd = read(EVIDENCE_FILES.taskDefinition(expect.primaryPool));
  const buildId = primaryTd.ok ? buildIdOf(primaryTd.value) : null;
  checks.push(judge("prerequisite: build identity", buildId !== null, `BUILD_ID ${String(buildId)} (the running task definition's)`, "the running task definition names no BUILD_ID"));
  const listing = cluster.ok ? readClusterListing(cluster.value, expect.environment) : null;
  const clusterListedAt = listing !== null && listing.ok ? listing.listedAt : null;
  return { checks, identity: { task_definitions: taskDefinitions, running_tasks: runningArns, build_id: buildId }, startup: verification.startup, running, clusterListedAt };
}

export function prerequisiteRecord(run: string, at: number, expect: { readonly environment: string; readonly generation: number; readonly primaryPool: string; readonly pools: readonly string[] }, result: PrerequisiteResult): Record<string, unknown> {
  return {
    format: PREREQUISITE_FORMAT,
    run_id: run,
    environment: expect.environment,
    generation: expect.generation,
    primary_pool: expect.primaryPool,
    pools: expect.pools,
    at: new Date(at).toISOString(),
    verdict: allPass(result.checks) ? "PASS" : "FAIL",
    identity: result.identity,
    checks: result.checks,
  };
}

/* ------------------------------------------------------------------ */
/* The gates                                                            */
/* ------------------------------------------------------------------ */

export interface CertContext {
  readonly dir: string;
  readonly run: string;
  readonly scenario: Scenario;
  readonly replacedPools: readonly string[];
  readonly environment: string;
  readonly generation: number;
  readonly primaryPool: string;
  readonly pools: readonly string[];
  readonly commit: string;
  /** The repository checkout (the committed Terraform lock files). */
  readonly repository: string;
  readonly prerequisite: PrerequisiteResult;
  /** L6-4: SYSTEM/GENERATION and APPGEN, read live through L6-4's readers (`recovery.ts`; not integrated: FAIL). */
  readonly generationEvidence: GenerationEvidence;
  /** L6-5A's TASK# heartbeats for a restore drill (null: not integrated -- ECS evidence alone, never a lease). */
  readonly heartbeats: HeartbeatEvidence | null;
  /** LIVE-6 final convergence (L6-5B): the alarm classes' configured destinations (`--page-actions` / `--ticket-actions`;
   *  `none` = an empty list, valid in staging; absent: null, class consistency only). */
  readonly alarmActions?: { readonly page: readonly string[] | null; readonly ticket: readonly string[] | null };
  /** LIVE-6 final convergence (relayer-rotation-drill): `--from-relayer` / `--to-relayer`. */
  readonly rotation?: { readonly from: string | null; readonly to: string | null } | null;
}

export type GateStatus = "pass" | "fail" | "not-required";

export interface GateResult {
  readonly id: string;
  readonly title: string;
  readonly status: GateStatus;
  readonly checks: readonly Check[];
  readonly note?: string;
  readonly measurements?: Record<string, unknown>;
}

export interface StagingGate {
  readonly id: string;
  readonly title: string;
  /** Whether the scenario requires it (a gate not required is reported with `notRequired`, never as a pass). */
  readonly required: (ctx: CertContext) => boolean;
  readonly notRequired?: string;
  readonly evaluate: (ctx: CertContext, records: Records) => { readonly checks: Check[]; readonly measurements?: Record<string, unknown> };
}

/** The evidence files every gate may read, read once (each scanned for secrets; a problem is a failed check). */
export interface Records {
  readonly prior: ReturnType<typeof readEvidence>;
  readonly taskRole: ReturnType<typeof readEvidence>;
  readonly taskRoleLog: ReturnType<typeof readEvidence>;
  readonly taskRoleRun: ReturnType<typeof readEvidence>;
  readonly edge: ReturnType<typeof readEvidence>;
  readonly capture: ReturnType<typeof readEvidence>;
}

const recordOrFail = (label: string, r: ReturnType<typeof readEvidence>): { value: Record<string, unknown> | null; checks: Check[] } =>
  r.ok ? { value: obj(r.value), checks: [] } : { value: null, checks: [fail(`${label}`, r.problem)] };

const priorAt = (records: Records): string | null => (records.prior.ok ? str(obj(records.prior.value).at) : null);

const envelopeFor = (ctx: CertContext, records: Records, record: Record<string, unknown>, probe: string, label: string): Check[] =>
  checkEnvelope(label, record, { probe, run: ctx.run, environment: ctx.environment, generation: ctx.generation, pool: ctx.primaryPool, notBefore: priorAt(records) });

const taskRoleSection = (ctx: CertContext, records: Records, name: string): { checks: Check[]; section: unknown } => {
  const r = recordOrFail(`${EVIDENCE.taskRole}`, records.taskRole);
  if (r.value === null) return { checks: r.checks, section: { status: "not-run", reason: `${EVIDENCE.taskRole} is missing` } };
  return { checks: envelopeFor(ctx, records, r.value, "task-role", "task-role probe"), section: obj(r.value.sections)[name] ?? { status: "not-run", reason: `the record has no ${name} section` } };
};

const edgeRecord = (ctx: CertContext, records: Records): { checks: Check[]; value: Record<string, unknown> | null } => {
  const r = recordOrFail(`${EVIDENCE.edge}`, records.edge);
  if (r.value === null) return { checks: r.checks, value: null };
  return { checks: envelopeFor(ctx, records, r.value, "edge", "edge probe"), value: obj(r.value.sections) };
};

const HOPS_CHECK = /trusted hops|proxies appended|counted address|GS_TRUSTED_PROXY_HOPS/;

const hopsOfTaskDefinition = (ctx: CertContext): string | null => {
  const td = readEvidence(ctx.dir, EVIDENCE_FILES.taskDefinition(ctx.primaryPool));
  if (!td.ok) return null;
  const game = arr(obj(obj(td.value).taskDefinition).containerDefinitions).map(obj).find((c) => c.name === "game-server");
  return str(arr(game?.environment).map(obj).find((e) => e.name === "GS_TRUSTED_PROXY_HOPS")?.value);
};

const distributionNames = (ctx: CertContext): { domainName: string | null; aliases: string[] } => {
  const dist = readEvidence(ctx.dir, EVIDENCE.distribution);
  const config = readEvidence(ctx.dir, EVIDENCE_FILES.distributionConfig);
  const domainName = dist.ok ? str(obj(obj(dist.value).Distribution).DomainName) : null;
  const aliases = config.ok ? arr(obj(obj(obj(config.value).DistributionConfig).Aliases).Items).map(String) : [];
  return { domainName, aliases };
};

/** The evidence's idle bounds: the ALB's idle timeout, and the /gs* origin's read timeout at CloudFront. */
export function idleBoundsOf(dir: string): { albIdleSeconds: number | null; originReadTimeoutSeconds: number | null } {
  const lb = readEvidence(dir, EVIDENCE_FILES.loadBalancerAttributes);
  const idle = lb.ok ? Number(arr(obj(lb.value).Attributes).map(obj).find((a) => a.Key === "idle_timeout.timeout_seconds")?.Value) : NaN;
  const config = readEvidence(dir, EVIDENCE_FILES.distributionConfig);
  let origin: number | null = null;
  if (config.ok) {
    const c = obj(obj(config.value).DistributionConfig);
    const behavior = arr(obj(c.CacheBehaviors).Items).map(obj).find((b) => b.PathPattern === "/gs*");
    const o = arr(obj(c.Origins).Items).map(obj).find((x) => x.Id === behavior?.TargetOriginId);
    origin = num(obj(o?.CustomOriginConfig).OriginReadTimeout);
  }
  return { albIdleSeconds: Number.isFinite(idle) ? idle : null, originReadTimeoutSeconds: origin };
}

/** The certifier task's own ECS record: the running definition, the probe command, the server refused, exit 0. */
export function judgeCertifierTask(doc: unknown, expect: { readonly run: string; readonly taskDefinition: string | null }): Check[] {
  const task = arr(obj(doc).tasks).map(obj)[0];
  if (task === undefined) return [fail("certifier task", `${EVIDENCE.taskRoleRun} holds no task`)];
  const override = arr(obj(task.overrides).containerOverrides).map(obj).find((o) => o.name === "game-server");
  const command = arr(override?.command).map(String);
  const env = arr(override?.environment).map(obj);
  const container = arr(task.containers).map(obj).find((c) => c.name === "game-server");
  const probeCommand = command.slice(0, 4).join(" ") === "node dist/server/src/tools/awsDeploy.js stage-probe task-role" && command[command.indexOf("--run-id") + 1] === expect.run;
  return [
    judge("certifier task: the running task definition", task.taskDefinitionArn === expect.taskDefinition && expect.taskDefinition !== null, String(task.taskDefinitionArn), `ran ${String(task.taskDefinitionArn)}, the primary service runs ${String(expect.taskDefinition)}`),
    judge("certifier task: the probe, never the server", probeCommand && env.some((e) => e.name === "GS_STORAGE" && e.value === CERTIFIER_STORAGE_OVERRIDE) && String(task.group).startsWith("family:"), "command override = stage-probe task-role for this run; GS_STORAGE overridden so a server could never start; not a service task", `command [${command.join(" ")}], group ${String(task.group)}`),
    judge("certifier task: finished cleanly", task.lastStatus === "STOPPED" && num(container?.exitCode) === 0, "STOPPED, exit 0", `${String(task.lastStatus)}, exit ${String(container?.exitCode)}`),
  ];
}

/** The certifier task's GS_STORAGE override: a value `start.ts` refuses (exit 2), so a missing command override starts nothing. */
export const CERTIFIER_STORAGE_OVERRIDE = "l6-6-probe-not-a-server";

export const STAGING_GATES: readonly StagingGate[] = Object.freeze([
  {
    id: "prerequisite",
    title: "Deployment-state prerequisite",
    required: () => true,
    evaluate: (ctx, records) => {
      const checks = [...ctx.prerequisite.checks];
      const prior = recordOrFail(EVIDENCE.prerequisite, records.prior);
      checks.push(...prior.checks);
      if (prior.value !== null) {
        const p = prior.value;
        checks.push(judge("prerequisite: recorded before the probes", p.format === PREREQUISITE_FORMAT && p.run_id === ctx.run && p.verdict === "PASS", `${EVIDENCE.prerequisite} PASS for ${ctx.run} at ${String(p.at)}`, `${EVIDENCE.prerequisite}: ${String(p.format)} run ${String(p.run_id)} verdict ${String(p.verdict)}`));
        checks.push(
          judge(
            "prerequisite: unchanged since the probes began",
            stableStringify(p.identity) === stableStringify(ctx.prerequisite.identity),
            "the same task definitions, running tasks and build",
            `the deployment moved during the run: then ${stableStringify(p.identity, 0).trim()}, now ${stableStringify(ctx.prerequisite.identity, 0).trim()}`,
          ),
        );
      }
      /* The captures the prerequisite judges must post-date every probe (recaptured after them). */
      const capture = recordOrFail(EVIDENCE.capture, records.capture);
      checks.push(...capture.checks);
      if (capture.value !== null) {
        const captured = Date.parse(String(capture.value.captured_at));
        const finishes = [records.taskRole, records.edge].filter((r) => r.ok).map((r) => Date.parse(String(obj(r.ok ? r.value : null).finished_at)));
        const last = Math.max(Number.NEGATIVE_INFINITY, ...finishes.filter((t) => Number.isFinite(t)));
        checks.push(judge("prerequisite: evidence captured after the probes", Number.isFinite(captured) && captured >= last - CLOCK_SKEW_MS, `captured ${String(capture.value.captured_at)}`, `captured ${String(capture.value.captured_at)}, before the last probe finished (${Number.isFinite(last) ? new Date(last).toISOString() : "?"}): run capture-evidence again, then certify`));
        /* L6-6P: the cluster listing itself post-dates the probes (not only the stamp written after it). */
        const listed = ctx.prerequisite.clusterListedAt ?? Number.NaN;
        checks.push(judge("prerequisite: cluster listing taken after the probes", Number.isFinite(listed) && listed >= last - CLOCK_SKEW_MS, `listed ${Number.isFinite(listed) ? new Date(listed).toISOString() : "?"}`, Number.isFinite(listed) ? `listed ${new Date(listed).toISOString()}, before the last probe finished (${Number.isFinite(last) ? new Date(last).toISOString() : "?"}): run capture-evidence again, then certify` : "no complete cluster listing to date"));
      }
      return { checks, measurements: { task_definition: ctx.prerequisite.identity.task_definitions[ctx.primaryPool] ?? null, build_id: ctx.prerequisite.identity.build_id } };
    },
  },
  {
    id: "drain",
    title: "Drain ordering (drain -> zero -> apply/start)",
    required: (ctx) => ctx.scenario === "replacement",
    notRequired: READ_ONLY_DRAIN_NOTE,
    evaluate: (ctx, records) => {
      if (ctx.replacedPools.length === 0) return { checks: [fail("drain: the replaced pools", "--scenario replacement names no pool (--replaced-pools)")] };
      return { checks: ctx.replacedPools.flatMap((pool) => judgeDrain(ctx.dir, pool, ctx.environment, ctx.prerequisite.running.get(pool) ?? [], { run: ctx.run, notAfter: priorAt(records) })) };
    },
  },
  {
    id: "iam",
    title: "DynamoDB IAM / LeadingKeys inside transactions (as the task role)",
    required: () => true,
    evaluate: (ctx, records) => {
      const { checks, section } = taskRoleSection(ctx, records, "iam");
      const run = recordOrFail(EVIDENCE.taskRoleRun, records.taskRoleRun);
      checks.push(...run.checks);
      if (run.value !== null) checks.push(...judgeCertifierTask(run.value, { run: ctx.run, taskDefinition: ctx.prerequisite.identity.task_definitions[ctx.primaryPool] ?? null }));
      if (records.taskRole.ok) {
        const runner = obj(obj(records.taskRole.value).runner);
        checks.push(judge("task-role probe: ran in an ECS task of this build", runner.ecs_task === true && runner.build_id === ctx.prerequisite.identity.build_id && runner.runtime_parameter_matches_env === true, `BUILD_ID ${String(runner.build_id)}, the task's own runtime document`, `ecs ${String(runner.ecs_task)}, BUILD_ID ${String(runner.build_id)} (the service runs ${String(ctx.prerequisite.identity.build_id)}), document matches ${String(runner.runtime_parameter_matches_env)}`));
        /* The record is the certifier task's: its own ARN (from the task metadata) is the task run-task started, and the
           record is exactly what that task printed to its log. */
        const certifier = run.value === null ? null : String(obj(arr(run.value.tasks)[0]).taskArn ?? "");
        checks.push(judge("task-role probe: the record is the certifier task's", certifier !== null && certifier !== "" && runner.task_arn === certifier, `task ${String(runner.task_arn).split("/").pop()}`, `the record names task ${String(runner.task_arn)}, the certifier task was ${String(certifier)}`));
        const log = records.taskRoleLog;
        const fromLog = log.ok ? recordFromLog(arr(obj(log.value).events).map((e) => String(obj(e).message ?? ""))) : null;
        checks.push(
          judge(
            "task-role probe: the record is exactly the task's log",
            fromLog !== null && fromLog.ok && stableStringify(fromLog.record) === stableStringify(records.taskRole.value),
            `reassembled from ${EVIDENCE.taskRoleLog} and SHA-256 checked`,
            log.ok ? (fromLog !== null && !fromLog.ok ? fromLog.problem : "the collected record differs from the one in the log") : log.problem,
          ),
        );
      }
      const role = `gs-${ctx.environment}-app-task`;
      checks.push(...(obj(section).status === "ran" ? judgeIamProbe(section, role, IAM_PROBE_IDS) : [fail("IAM", `not run (${String(obj(section).reason ?? "?")})`)]));
      const outcomes = arr(obj(section).results).length;
      return { checks, measurements: { probes: outcomes, role } };
    },
  },
  {
    id: "transactions",
    title: "Real DynamoDB conditional writes / TransactionConflict / same-token resend",
    required: () => true,
    evaluate: (ctx, records) => {
      const { checks, section } = taskRoleSection(ctx, records, "transactions");
      checks.push(...judgeTransactionProbe(section));
      const t3 = obj(obj(obj(section).results).t3);
      return { checks, measurements: { conflicts: t3.conflicts ?? null, applied: t3.applied ?? null } };
    },
  },
  {
    id: "proxy-hops",
    title: "GS_TRUSTED_PROXY_HOPS=2 through the deployed edge",
    required: () => true,
    evaluate: (ctx, records) => {
      const e = edgeRecord(ctx, records);
      if (e.value === null) return { checks: e.checks };
      const all = judgeQueryProbe(e.value, { run: ctx.run, hopsFromTaskDefinition: hopsOfTaskDefinition(ctx) });
      return { checks: [...e.checks, ...judgeEdgeTarget(e.value, distributionNames(ctx)), ...all.filter((c) => HOPS_CHECK.test(c.name))] };
    },
  },
  {
    id: "query-strings",
    title: "cp, cr, cb (and every query string) through CloudFront",
    required: () => true,
    evaluate: (ctx, records) => {
      const e = edgeRecord(ctx, records);
      if (e.value === null) return { checks: e.checks };
      const all = judgeQueryProbe(e.value, { run: ctx.run, hopsFromTaskDefinition: hopsOfTaskDefinition(ctx) });
      return { checks: [...e.checks, ...judgeEdgeTarget(e.value, distributionNames(ctx)), ...all.filter((c) => !HOPS_CHECK.test(c.name))] };
    },
  },
  {
    id: "websocket",
    title: "WebSocket: the announcement on /gs, and idle through CloudFront + ALB",
    required: () => true,
    evaluate: (ctx, records) => {
      const e = edgeRecord(ctx, records);
      if (e.value === null) return { checks: e.checks };
      const idle = obj(obj(e.value.ws_idle).observation);
      return {
        checks: [...e.checks, ...judgeEdgeTarget(e.value, distributionNames(ctx)), ...judgeWsAnnouncement(e.value), ...judgeWsIdle(e.value, idleBoundsOf(ctx.dir))],
        measurements: { idle_ms: idle.duration_ms ?? null, pings: arr(idle.events).map(obj).filter((x) => x.kind === "ping").length },
      };
    },
  },
  {
    id: "kms",
    title: "KMS signing latency (< 3 s) with the configured keys",
    required: () => true,
    evaluate: (ctx, records) => {
      const { checks, section } = taskRoleSection(ctx, records, "kms");
      checks.push(...judgeKmsProbe(section));
      const keys = obj(obj(obj(section).results).keys);
      const measurements: Record<string, unknown> = {};
      for (const purpose of ["relayer", "settlement", "admission"]) {
        const ms = arr(obj(keys[purpose]).samples).map((x) => num(obj(x).ms)).filter((x): x is number => x !== null);
        measurements[purpose] = ms.length === 0 ? null : { max_ms: Math.max(...ms), samples: ms.length };
      }
      return { checks, measurements };
    },
  },
  {
    id: "terraform",
    title: "Terraform plans (ledger, app): versions, lock, exit status, nothing destroyed, services gated",
    required: () => true,
    evaluate: (ctx, records) => {
      const checks: Check[] = [];
      const measurements: Record<string, unknown> = {};
      for (const stack of STACKS) {
        const base = EVIDENCE.terraformDir(stack);
        const version = readEvidence(ctx.dir, path.join(base, TERRAFORM_FILES.version));
        const plan = readEvidence(ctx.dir, path.join(base, TERRAFORM_FILES.plan));
        const exit = readEvidenceText(ctx.dir, path.join(base, TERRAFORM_FILES.exitCode));
        const lock = readEvidenceText(ctx.dir, path.join(base, TERRAFORM_FILES.lock));
        const missing = [version, plan, exit, lock].filter((r) => !r.ok).map((r) => (r.ok ? "" : r.problem));
        if (missing.length > 0) {
          checks.push(fail(`terraform ${stack}: evidence`, `${missing.join("; ")} (infra/aws/scripts/plan-evidence)`));
          continue;
        }
        let repositoryLock = "";
        try {
          repositoryLock = fs.readFileSync(path.join(ctx.repository, "infra/aws/stacks", stack, ".terraform.lock.hcl"), "utf8");
        } catch {
          checks.push(fail(`terraform ${stack}: the repository's lock`, `infra/aws/stacks/${stack}/.terraform.lock.hcl is not in ${ctx.repository}`));
        }
        const judged = judgeTerraformStack(stack, { version: version.ok ? version.value : null, plan: plan.ok ? plan.value : null, exitCode: exit.ok ? exit.text : "", lock: lock.ok ? lock.text : "" }, repositoryLock, { primaryPool: ctx.primaryPool });
        checks.push(...judged.checks);
        /* This run's plan: its stamp names the run, and Terraform's own timestamp is not before the prerequisite. */
        const stamp = readEvidence(ctx.dir, path.join(base, TERRAFORM_FILES.run));
        const planned = Date.parse(String(obj(plan.ok ? plan.value : null).timestamp));
        const since = Date.parse(String(priorAt(records)));
        checks.push(
          judge(
            `terraform ${stack}: this run's plan`,
            stamp.ok && obj(stamp.value).run_id === ctx.run && Number.isFinite(planned) && Number.isFinite(since) && planned >= since - CLOCK_SKEW_MS,
            `planned ${String(obj(plan.ok ? plan.value : null).timestamp)} for ${ctx.run}`,
            !stamp.ok ? stamp.problem : obj(stamp.value).run_id !== ctx.run ? `the plan evidence is run ${String(obj(stamp.value).run_id)}'s` : `planned ${String(obj(plan.ok ? plan.value : null).timestamp ?? "(no timestamp)")}, before the prerequisite (${String(priorAt(records))}): plan again`,
          ),
        );
        measurements[stack] = judged.summary;
      }
      return { checks, measurements };
    },
  },
  {
    id: "generation",
    title: "SYSTEM/GENERATION and the APPGEN adoption binding (L6-4)",
    required: () => true,
    evaluate: (ctx) => ({
      checks: judgeGeneration(ctx.generationEvidence, { generation: ctx.prerequisite.startup.config.generation, gameTable: ctx.prerequisite.startup.config.gameTable, requireRestore: ctx.scenario === "restore-drill" }),
      measurements: generationMeasurement(ctx.generationEvidence) ?? { integrated: false },
    }),
  },
  {
    id: "identity",
    title: "Identity restore state and TABLE#identity binding (L6-4)",
    required: () => true,
    evaluate: (ctx, records) => {
      const { checks, section } = taskRoleSection(ctx, records, "identity_state");
      checks.push(...judgeIdentityRecovery(section, ctx.prerequisite.startup.config.identityTable));
      const st = obj(obj(section).state);
      return { checks, measurements: { restore_state: st.restore_state ?? null, restore_id: st.restore_id ?? null, table_binding: st.table_binding ?? null } };
    },
  },
  {
    id: "review",
    title: "REVIEW#: no unresolved recovery review (L6-4)",
    required: () => true,
    evaluate: (ctx, records) => {
      const { checks, section } = taskRoleSection(ctx, records, "identity_state");
      checks.push(...judgeReviews(section));
      return { checks };
    },
  },
  {
    id: "rollback",
    title: "Deployment invariant: L6-4 in the serving image and every automatic rollback target",
    required: () => true,
    evaluate: (ctx, records) => {
      const runner = records.taskRole.ok ? obj(obj(records.taskRole.value).runner) : {};
      const own = certifierImage(ctx.dir, { primaryPool: ctx.primaryPool, primaryTaskDefinition: ctx.prerequisite.identity.task_definitions[ctx.primaryPool] ?? null, primaryBuild: ctx.prerequisite.identity.build_id, runner });
      return {
        checks: judgeRollback(ctx.dir, {
          environment: ctx.environment,
          pools: ctx.pools,
          primaryPool: ctx.primaryPool,
          primaryBuild: ctx.prerequisite.identity.build_id,
          runningTaskDefinitions: ctx.prerequisite.identity.task_definitions,
          running: ctx.prerequisite.running,
          runner,
        }),
        measurements: { build_capabilities: runner.build_capabilities ?? null, image: own.image, image_digest: own.digest },
      };
    },
  },
  {
    id: "restore-quiet",
    title: "Restore drill: the stop before adoption",
    required: (ctx) => ctx.scenario === "restore-drill",
    notRequired: "not required: no restore drill in this scenario",
    evaluate: (ctx) => ({
      checks: [
        ...(ctx.generationEvidence.integrated ? [] : [fail("restore: the adoption time", NOT_INTEGRATED)]),
        ...judgeRestoreQuiet(ctx.dir, { run: ctx.run, environment: ctx.environment, pools: ctx.pools, adoption: adoptionOf(ctx.generationEvidence), heartbeats: ctx.heartbeats }),
      ],
    }),
  },
  {
    id: "restore-fence",
    title: "Restore drill: the old generation fenced, the new one started",
    required: (ctx) => ctx.scenario === "restore-drill",
    notRequired: "not required: no restore drill in this scenario",
    evaluate: (ctx) => ({
      checks: [...(ctx.generationEvidence.integrated ? [] : [fail("restore fencing: the adoption", NOT_INTEGRATED)]), ...judgeRestoreFencing(ctx.dir, { run: ctx.run, adoption: adoptionOf(ctx.generationEvidence) })],
    }),
  },
  /* ---------------- LIVE-6 final convergence: L6-5B / L6-2 / L6-7 bound to the harness (`drills.ts`) ---------------- */
  {
    id: "alarms",
    title: "CloudWatch alarms against the L6-5B contract (and their identity)",
    required: () => true,
    evaluate: (ctx) => {
      const flip = ctx.scenario === "flip-drill" ? flipWindowOf(flipRecordOf(ctx.dir).record) : null;
      return judgeAlarmsGate(ctx.dir, {
        environment: ctx.environment,
        region: ctx.prerequisite.startup.config.region,
        account: accountOf(String(ctx.prerequisite.identity.task_definitions[ctx.primaryPool] ?? "")),
        pools: ctx.pools,
        primaryPool: ctx.primaryPool,
        escrow: ctx.prerequisite.startup.escrowConfig !== null,
        pageActions: ctx.alarmActions?.page ?? null,
        ticketActions: ctx.alarmActions?.ticket ?? null,
        flip,
      });
    },
  },
  {
    id: "generation-gate",
    title: "Restore drill: the generation gate's own record, bound to the ledger's APPGEN#HISTORY",
    required: (ctx) => ctx.scenario === "restore-drill",
    notRequired: "not required: no generation switch in this scenario",
    evaluate: (ctx, records) => ({
      checks: [
        ...(ctx.generationEvidence.integrated ? [] : [fail("generation gate: the adoption", NOT_INTEGRATED)]),
        ...judgeGenerationGateRecord(ctx.dir, { environment: ctx.environment, generation: ctx.prerequisite.startup.config.generation, gameTable: ctx.prerequisite.startup.config.gameTable, evidence: ctx.generationEvidence, prerequisiteAt: priorAt(records) }),
      ],
    }),
  },
  {
    id: "restore-alarms",
    title: "Restore drill: R1, A4g, A4i, R2, R3 fire and are never suppressed by a flip window",
    required: (ctx) => ctx.scenario === "restore-drill",
    notRequired: "not required: no restore drill in this scenario",
    evaluate: (ctx) => ({ checks: judgeRestoreAlarmDrill(ctx.dir, { run: ctx.run, environment: ctx.environment, pools: ctx.pools }) }),
  },
  {
    id: "flip",
    title: "Flip drill: window before the CAS, roles settled, exit 5 only, /gs* moved, recovery settled, suppression bounded",
    required: (ctx) => ctx.scenario === "flip-drill",
    notRequired: "not required: no flip drill in this scenario",
    evaluate: (ctx) => ({ checks: judgeFlipDrill(ctx.dir, { environment: ctx.environment, pools: ctx.pools, primaryPool: ctx.primaryPool, escrow: ctx.prerequisite.startup.escrowConfig !== null }) }),
  },
  {
    id: "flip-alarms",
    title: "Flip drill: an exit 3 still pages A1; a still-failing alarm acts after the window; only the flip's pools suppressed",
    required: (ctx) => ctx.scenario === "flip-drill",
    notRequired: "not required: no flip drill in this scenario",
    evaluate: (ctx) => ({ checks: judgeFlipAlarmDrill(ctx.dir, { run: ctx.run, environment: ctx.environment, pools: ctx.pools }) }),
  },
  {
    id: "relayer-rotation",
    title: "Relayer-address rotation drill: the gate OPEN before the change, the old queue empty, every pool drained",
    required: (ctx) => ctx.scenario === "relayer-rotation-drill",
    notRequired: "not required: no relayer-address rotation in this scenario",
    evaluate: (ctx, records) => ({
      checks: judgeRotationDrill(ctx.dir, {
        environment: ctx.environment,
        from: ctx.rotation?.from ?? null,
        to: ctx.rotation?.to ?? null,
        pools: ctx.pools,
        configuredRelayer: ctx.prerequisite.startup.escrowConfig?.relayer.address ?? null,
        prerequisiteAt: priorAt(records),
        running: ctx.prerequisite.running,
      }),
    }),
  },
  {
    id: "evidence",
    title: "Evidence package: identity, and no secret anywhere",
    required: () => true,
    evaluate: (ctx) => {
      const files = manifestOf(ctx.dir);
      const leaking = files.filter((f) => f.findings.length > 0);
      return {
        checks: [
          judge(
            "evidence: commit",
            /^[0-9a-f]{7,40}$/.test(ctx.commit) && repositoryHead(ctx.repository)?.startsWith(ctx.commit) === true,
            `${ctx.commit} (the checkout whose Terraform locks were compared)`,
            /^[0-9a-f]{7,40}$/.test(ctx.commit) ? `--commit ${ctx.commit} is not the checkout's HEAD (${String(repositoryHead(ctx.repository))}) in ${ctx.repository}` : `--commit ${ctx.commit} is not a git commit id`,
          ),
          judge("evidence: build", ctx.prerequisite.identity.build_id !== null, `BUILD_ID ${String(ctx.prerequisite.identity.build_id)}`, "no BUILD_ID"),
          judge("evidence: no secret in the package", files.length > 0 && leaking.length === 0, `${files.length} files scanned (credentials, tokens, cookies, private keys, recovery material, player identity, wallet proofs)`, leaking.length > 0 ? leaking.map((f) => `${f.file}: ${f.findings.join(", ")}`).join("; ") : "the evidence directory is empty"),
        ],
        measurements: { files: files.length },
      };
    },
  },
]);

/* ------------------------------------------------------------------ */
/* Certify and report                                                   */
/* ------------------------------------------------------------------ */

export function readRecords(dir: string): Records {
  return {
    prior: readEvidence(dir, EVIDENCE.prerequisite, { ownRecord: true }),
    taskRole: readEvidence(dir, EVIDENCE.taskRole, { ownRecord: true }),
    taskRoleLog: readEvidence(dir, EVIDENCE.taskRoleLog),
    taskRoleRun: readEvidence(dir, EVIDENCE.taskRoleRun),
    edge: readEvidence(dir, EVIDENCE.edge, { ownRecord: true }),
    capture: readEvidence(dir, EVIDENCE.capture),
  };
}

export const VERDICT_LINE = (passed: boolean): string => `LIVE-6 AWS STAGING CERTIFICATION: ${passed ? "PASS" : "FAIL"}`;

export function certify(ctx: CertContext, extraGates: readonly StagingGate[] = []): { readonly passed: boolean; readonly gates: readonly GateResult[] } {
  const records = readRecords(ctx.dir);
  const gates: GateResult[] = [];
  for (const gate of [...STAGING_GATES, ...extraGates]) {
    if (!gate.required(ctx)) {
      gates.push({ id: gate.id, title: gate.title, status: "not-required", checks: [], note: gate.notRequired ?? "not required by this scenario" });
      continue;
    }
    let evaluated: { checks: Check[]; measurements?: Record<string, unknown> };
    try {
      evaluated = gate.evaluate(ctx, records);
    } catch (error) {
      evaluated = { checks: [fail(`${gate.id}: evaluation`, `the gate could not be evaluated (${error instanceof Error ? error.message : String(error)})`)] };
    }
    gates.push({ id: gate.id, title: gate.title, status: allPass(evaluated.checks) ? "pass" : "fail", checks: evaluated.checks, ...(evaluated.measurements === undefined ? {} : { measurements: evaluated.measurements }) });
  }
  return { passed: gates.every((g) => g.status !== "fail") && gates.some((g) => g.status === "pass"), gates };
}

export function certificationRecord(ctx: CertContext, result: { readonly passed: boolean; readonly gates: readonly GateResult[] }): Record<string, unknown> {
  return {
    format: CERTIFICATION_FORMAT,
    verdict: result.passed ? "PASS" : "FAIL",
    failed_gates: result.gates.filter((g) => g.status === "fail").map((g) => g.id),
    run_id: ctx.run,
    scenario: ctx.scenario,
    environment: ctx.environment,
    generation: ctx.generation,
    primary_pool: ctx.primaryPool,
    pools: ctx.pools,
    commit: ctx.commit,
    build_id: ctx.prerequisite.identity.build_id,
    ...(() => {
      /* The image's own L6-4 evidence (the certifier task's report) and the image ECS ran it from: a later run's rollback
         gate attests THIS image (by its reference and digest, never the BUILD_ID text) only from a PASS of this record. */
      const r = readEvidence(ctx.dir, EVIDENCE.taskRole, { ownRecord: true });
      const runner = r.ok ? obj(obj(r.value).runner) : {};
      const own = certifierImage(ctx.dir, { primaryPool: ctx.primaryPool, primaryTaskDefinition: ctx.prerequisite.identity.task_definitions[ctx.primaryPool] ?? null, primaryBuild: ctx.prerequisite.identity.build_id, runner });
      return { build_capabilities: runner.build_id === ctx.prerequisite.identity.build_id ? (runner.build_capabilities ?? null) : null, image: own.image, image_digest: own.digest };
    })(),
    task_definitions: ctx.prerequisite.identity.task_definitions,
    gates: result.gates,
  };
}

/** The human-readable report. Its FIRST line is the verdict; then every failed gate, then every gate's checks. */
export function certificationText(ctx: CertContext, result: { readonly passed: boolean; readonly gates: readonly GateResult[] }): string {
  const failed = result.gates.filter((g) => g.status === "fail");
  const lines = [VERDICT_LINE(result.passed)];
  lines.push(failed.length === 0 ? "failed gates: none" : `failed gates: ${failed.map((g) => g.id).join(", ")}`);
  for (const g of failed) for (const c of g.checks.filter((x) => x.status !== "pass")) lines.push(`  FAIL  [${g.id}] ${c.name} -- ${c.detail}`);
  lines.push("");
  lines.push(`run ${ctx.run} | scenario ${ctx.scenario} | environment ${ctx.environment} | generation ${ctx.generation} | primary pool ${ctx.primaryPool} | pools ${ctx.pools.join(",")}`);
  lines.push(`commit ${ctx.commit} | build ${String(ctx.prerequisite.identity.build_id)} | task definition ${String(ctx.prerequisite.identity.task_definitions[ctx.primaryPool])}`);
  result.gates.forEach((g, i) => {
    lines.push("");
    lines.push(`${i + 1}. ${g.title} [${g.id}]: ${g.status === "pass" ? "PASS" : g.status === "fail" ? "FAIL" : "NOT REQUIRED"}${g.note !== undefined ? ` -- ${g.note}` : ""}`);
    for (const c of g.checks) lines.push(`   ${c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "SKIP"}  ${c.name} -- ${c.detail}`);
    if (g.measurements !== undefined) lines.push(`   measurements: ${stableStringify(g.measurements, 0).trim()}`);
  });
  return `${lines.join("\n")}\n`;
}

/** Remove a previous certification's outputs FIRST, so a rerun that fails or is refused never leaves an older PASS. */
export function clearCertification(dir: string): void {
  for (const file of [EVIDENCE.certification, EVIDENCE.certificationText, EVIDENCE.manifest]) fs.rmSync(path.join(dir, file), { force: true });
}

/** The checkout's HEAD commit (a detached HEAD, a branch ref, or a packed ref); null when it cannot be read. */
export function repositoryHead(repository: string): string | null {
  try {
    let git = path.join(repository, ".git");
    /* A worktree or submodule: `.git` is a file naming the real git directory (refs may live in its common directory). */
    if (fs.statSync(git).isFile()) git = path.resolve(repository, /^gitdir: (.+)$/m.exec(fs.readFileSync(git, "utf8"))?.[1]?.trim() ?? "");
    let common = git;
    try {
      common = path.resolve(git, fs.readFileSync(path.join(git, "commondir"), "utf8").trim());
    } catch {
      /* not a worktree */
    }
    const head = fs.readFileSync(path.join(git, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref: (refs\/[^\s]+)$/.exec(head)?.[1];
    if (ref === undefined) return null;
    for (const dir of [git, common]) {
      try {
        return fs.readFileSync(path.join(dir, ref), "utf8").trim();
      } catch {
        /* try the next place, then packed-refs */
      }
    }
    {
      const packed = fs.readFileSync(path.join(common, "packed-refs"), "utf8");
      return new RegExp(`^([0-9a-f]{40}) ${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").exec(packed)?.[1] ?? null;
    }
  } catch {
    return null;
  }
}

/** Write certification.json, CERTIFICATION.txt and MANIFEST.json (in that order; the manifest covers the evidence). */
export function writeCertification(ctx: CertContext, result: { readonly passed: boolean; readonly gates: readonly GateResult[] }): string {
  const text = certificationText(ctx, result);
  const manifest = manifestOf(ctx.dir).map((f) => ({ file: f.file, bytes: f.bytes, sha256: f.sha256 }));
  writeRecord(ctx.dir, EVIDENCE.manifest, { format: CERTIFICATION_FORMAT, run_id: ctx.run, files: manifest });
  writeRecord(ctx.dir, EVIDENCE.certification, certificationRecord(ctx, result));
  fs.writeFileSync(path.join(ctx.dir, EVIDENCE.certificationText), text, "utf8");
  return text;
}

/** For the certifier-task scripts: the prerequisite record says PASS for this run. */
export const prerequisitePassed = (dir: string, run: string): boolean => {
  const r = readEvidence(dir, EVIDENCE.prerequisite, { ownRecord: true });
  return r.ok && obj(r.value).verdict === "PASS" && obj(r.value).run_id === run;
};

export { pass };
