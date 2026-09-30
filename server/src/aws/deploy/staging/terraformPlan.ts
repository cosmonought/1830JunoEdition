// server/src/aws/deploy/staging/terraformPlan.ts
//
// ==================================================================
//  LIVE-6 L6-6 §9: THE FIRST REAL PLANS -- CAPTURED DETERMINISTICALLY, JUDGED, NEVER APPLIED
// ==================================================================
//
// infra/aws/scripts/plan-evidence.{sh,ps1} runs, per stack, `terraform version -json`, `terraform plan
// -detailed-exitcode -out` and `terraform show -json` of that plan, and copies the stack's `.terraform.lock.hcl`, into
// `terraform/<stack>/` of the evidence directory. It never applies (the saved plan file is deleted after `show`). This
// module judges those files -- a destructive plan FAILS the certification, it is not merely printed:
//
//   VERSION     Terraform >= 1.9 and the hashicorp/aws provider selected at exactly 6.66.0;
//   LOCK        the lock file used carries 6.66.0 and exactly the repository's committed hashes;
//   EXIT        `-detailed-exitcode` 0 (no changes) or 2 (changes); 1 (an error, e.g. a failed precondition) FAILS;
//   STACK       the plan is this stack's (`module.app` / `module.ledger`) and says it did not error;
//   NOTHING DESTROYED   no resource is deleted, forgotten or replaced -- except an ECS task-definition revision whose
//               `skip_destroy` keeps the old revision registered (the circuit breaker's rollback target). A protected
//               resource (tables, KMS keys, the backup vault and its lock, SSM documents, roles, the ALB, the target group,
//               the distribution, ECR, the cluster, the services, log groups, security groups) is named as such;
//   GATED (app) a service is created or changed only with `start_services = true` AND a routing read AT PLAN TIME
//               (`data.aws_dynamodb_table_item.routing[0]` in the plan's prior state -- not deferred to apply) whose item
//               is format 1 naming the primary pool; every planned service is stop-first 0/100, at most one task, AZ
//               rebalancing DISABLED. With `start_services = false` no service is created at all.

import type { Check } from "../deployVerify";
import { arr, judge, obj, str } from "./evidence";

export const TERRAFORM_MIN_VERSION = "1.9.0";
export const AWS_PROVIDER = "registry.terraform.io/hashicorp/aws";
export const AWS_PROVIDER_VERSION = "6.66.0";
export const STACKS = ["ledger", "app"] as const;
export type Stack = (typeof STACKS)[number];

export const TERRAFORM_FILES = Object.freeze({ version: "version.json", plan: "plan.json", exitCode: "plan-exitcode.txt", lock: "lock.hcl", run: "run.json" });

/** The resource types a plan may never delete or replace, named in the failure. */
export const PROTECTED_TYPES: readonly string[] = Object.freeze([
  "aws_dynamodb_table",
  "aws_dynamodb_resource_policy",
  "aws_kms_key",
  "aws_backup_vault",
  "aws_backup_vault_lock_configuration",
  "aws_backup_vault_policy",
  "aws_backup_plan",
  "aws_backup_selection",
  "aws_ssm_parameter",
  "aws_iam_role",
  "aws_lb",
  "aws_lb_listener",
  "aws_lb_target_group",
  "aws_cloudfront_distribution",
  "aws_cloudfront_origin_request_policy",
  "aws_ecr_repository",
  "aws_ecs_cluster",
  "aws_ecs_service",
  "aws_cloudwatch_log_group",
  "aws_security_group",
]);

const versionAtLeast = (actual: string, minimum: string): boolean => {
  const a = actual.split(".").map((x) => parseInt(x, 10));
  const m = minimum.split(".").map((x) => parseInt(x, 10));
  if (a.length < 3 || a.some((x) => !Number.isInteger(x))) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== m[i]) return a[i] > m[i];
  }
  return true;
};

/** The aws provider's version and hashes in a lock file (null: no such block). */
export function lockedAwsProvider(lockText: string): { readonly version: string; readonly hashes: readonly string[] } | null {
  const at = lockText.indexOf(`provider "${AWS_PROVIDER}"`);
  if (at < 0) return null;
  const block = lockText.slice(at, lockText.indexOf("\n}", at) + 2);
  const version = /\bversion\s*=\s*"([^"]+)"/.exec(block)?.[1] ?? null;
  const hashesBlock = /hashes\s*=\s*\[([\s\S]*?)\]/.exec(block)?.[1] ?? "";
  const hashes = [...hashesBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  return version === null ? null : { version, hashes };
}

interface ResourceChange {
  readonly address: string;
  readonly type: string;
  readonly mode: string;
  readonly actions: readonly string[];
  readonly after: Record<string, unknown>;
  readonly before: Record<string, unknown>;
  readonly reason: string | null;
}

const changesOf = (plan: unknown): ResourceChange[] =>
  arr(obj(plan).resource_changes)
    .map(obj)
    .map((rc) => ({
      address: String(rc.address),
      type: String(rc.type),
      mode: String(rc.mode),
      actions: arr(obj(rc.change).actions).map(String),
      after: obj(obj(rc.change).after),
      before: obj(obj(rc.change).before),
      reason: str(rc.action_reason),
    }));

/** Every data resource the plan read (its prior state), by address. */
function priorDataResources(plan: unknown): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const walk = (module: unknown) => {
    for (const r of arr(obj(module).resources).map(obj)) if (r.mode === "data") out.set(String(r.address), obj(r.values));
    for (const child of arr(obj(module).child_modules)) walk(child);
  };
  walk(obj(obj(obj(plan).prior_state).values).root_module);
  return out;
}

const summarize = (changes: readonly ResourceChange[]) => {
  const count: Record<string, number> = { create: 0, update: 0, replace: 0, delete: 0, forget: 0, read: 0, "no-op": 0 };
  for (const c of changes) {
    const replace = c.actions.includes("delete") && c.actions.includes("create");
    const key = replace ? "replace" : c.actions.includes("delete") ? "delete" : c.actions.includes("forget") ? "forget" : (c.actions[0] ?? "no-op");
    count[key] = (count[key] ?? 0) + 1;
  }
  return count;
};

const first = (value: unknown): Record<string, unknown> => obj(Array.isArray(value) ? value[0] : value);

/** What an in-place update would switch off (the protections L5-8 builds in; empty: none). */
export function weakenedProtection(c: { readonly type: string; readonly before: Record<string, unknown>; readonly after: Record<string, unknown> }): string[] {
  const out: string[] = [];
  if (c.type === "aws_dynamodb_table") {
    if (c.after.deletion_protection_enabled === false) out.push("deletion protection off");
    if (first(c.after.point_in_time_recovery).enabled === false) out.push("point-in-time recovery off");
    if (typeof c.after.stream_enabled === "boolean" && c.after.stream_enabled && c.before.stream_enabled !== true) out.push("a stream added");
    if (Array.isArray(c.after.replica) && c.after.replica.length > 0) out.push("a replica added");
  }
  if (c.type === "aws_kms_key") {
    if (c.after.is_enabled === false) out.push("the key disabled");
    if (c.after.multi_region === true) out.push("made multi-region");
    if (typeof c.before.policy === "string" && typeof c.after.policy === "string" && c.before.policy !== c.after.policy && /kms:(CreateGrant|\*)|"kms:\*"/.test(c.after.policy) && !/kms:(CreateGrant|\*)/.test(c.before.policy)) out.push("the key policy gains kms:CreateGrant or kms:*");
  }
  if (c.type === "aws_backup_vault_lock_configuration" && c.before.min_retention_days !== undefined && Number(c.after.min_retention_days) < Number(c.before.min_retention_days)) out.push("the vault lock's retention shortened");
  if (c.type === "aws_ecs_service") {
    if (c.after.deployment_minimum_healthy_percent !== undefined && c.after.deployment_minimum_healthy_percent !== 0) out.push("no longer stop-first");
    if (c.after.enable_execute_command === true) out.push("ECS Exec enabled");
  }
  if (c.type === "aws_ecs_task_definition" && c.after.skip_destroy === false) out.push("skip_destroy off (the rollback's revisions would be deregistered)");
  return out;
}

export interface TerraformEvidence {
  readonly version: unknown;
  readonly plan: unknown;
  readonly exitCode: string;
  readonly lock: string;
}

/** One stack's plan, judged. `repositoryLock`: the stack's committed `.terraform.lock.hcl`. */
export function judgeTerraformStack(stack: Stack, evidence: TerraformEvidence, repositoryLock: string, expect: { readonly primaryPool: string }): { readonly checks: Check[]; readonly summary: Record<string, unknown> } {
  const label = `terraform ${stack}`;
  const checks: Check[] = [];
  const v = obj(evidence.version);
  const tfVersion = String(v.terraform_version ?? "");
  const selected = obj(v.provider_selections)[AWS_PROVIDER];
  checks.push(judge(`${label}: Terraform version`, versionAtLeast(tfVersion, TERRAFORM_MIN_VERSION), tfVersion, `Terraform ${tfVersion || "(unknown)"} (>= ${TERRAFORM_MIN_VERSION} required)`));
  checks.push(judge(`${label}: provider selected`, selected === AWS_PROVIDER_VERSION, `hashicorp/aws ${AWS_PROVIDER_VERSION}`, `hashicorp/aws ${String(selected ?? "(not selected: run it in the initialised stack)")}`));

  const used = lockedAwsProvider(evidence.lock);
  const committed = lockedAwsProvider(repositoryLock);
  checks.push(
    judge(
      `${label}: provider lock`,
      used !== null && committed !== null && used.version === AWS_PROVIDER_VERSION && JSON.stringify(used.hashes) === JSON.stringify(committed.hashes),
      `${AWS_PROVIDER_VERSION}, the repository's ${committed?.hashes.length ?? 0} hashes`,
      used === null ? "no hashicorp/aws block in the lock file used" : `the lock used carries ${used.version} and ${used.hashes.length} hashes; the repository's: ${committed?.version ?? "?"} / ${committed?.hashes.length ?? 0}`,
    ),
  );

  const exit = evidence.exitCode.trim();
  checks.push(judge(`${label}: plan exit status`, exit === "0" || exit === "2", exit === "0" ? "0 (no changes)" : "2 (changes planned)", `exit ${exit || "(none)"} (1: the plan failed -- a precondition, a validation or an API error)`));

  const plan = obj(evidence.plan);
  const changes = changesOf(plan);
  const prefix = `module.${stack}.`;
  const foreign = changes.filter((c) => !c.address.startsWith(prefix)).map((c) => c.address);
  checks.push(
    judge(
      `${label}: the plan is this stack's`,
      typeof plan.format_version === "string" && plan.errored !== true && String(plan.terraform_version ?? "") === tfVersion && changes.length > 0 && foreign.length === 0,
      `${changes.length} resources under ${prefix.slice(0, -1)}, format ${String(plan.format_version)}`,
      plan.errored === true ? "the plan errored" : changes.length === 0 ? "no resource_changes (not a `terraform show -json` of a plan?)" : foreign.length > 0 ? `resources outside ${prefix.slice(0, -1)}: ${foreign.slice(0, 5).join(", ")}` : `format ${String(plan.format_version)}, Terraform ${String(plan.terraform_version)} (version.json says ${tfVersion})`,
    ),
  );

  const destructive = changes.filter((c) => c.mode === "managed" && (c.actions.includes("delete") || c.actions.includes("forget")));
  /* The PRIOR state's skip_destroy decides whether the old revision is deregistered (the provider deletes with it). */
  const acceptable = (c: ResourceChange) => c.type === "aws_ecs_task_definition" && c.actions.includes("create") && c.actions.includes("delete") && c.before.skip_destroy === true && c.after.skip_destroy === true;
  const unexpected = destructive.filter((c) => !acceptable(c));
  checks.push(
    judge(
      `${label}: nothing destroyed or replaced`,
      unexpected.length === 0,
      destructive.length === 0 ? "no delete, forget or replace" : `only ${destructive.length} task-definition revision(s) replaced (skip_destroy keeps the old ones)`,
      unexpected
        .map((c) => `${PROTECTED_TYPES.includes(c.type) ? "PROTECTED " : ""}${c.address} [${c.actions.join(",")}]${c.reason !== null ? ` (${c.reason})` : ""}`)
        .join("; "),
    ),
  );

  /* An IN-PLACE update that lowers a protected resource's protection is as destructive as a delete. */
  const weakened = changes
    .filter((c) => c.mode === "managed" && c.actions.includes("update"))
    .flatMap((c) => weakenedProtection(c).map((what) => `${c.address}: ${what}`));
  checks.push(judge(`${label}: no protection lowered in place`, weakened.length === 0, "deletion protection, PITR, key state and vault lock unchanged or raised", weakened.join("; ")));

  if (stack === "app") {
    const variables = obj(plan.variables);
    const start = obj(variables.start_services).value;
    const services = changes.filter((c) => c.mode === "managed" && c.type === "aws_ecs_service" && (c.actions.includes("create") || c.actions.includes("update")));
    if (services.length === 0) {
      checks.push(judge(`${label}: services gated on the bootstrap`, true, start === true ? "start_services = true; no service created or changed" : "start_services = false: no service is created", ""));
    } else {
      const routingAddress = [...priorDataResources(plan).keys()].find((a) => /data\.aws_dynamodb_table_item\.routing\[0\]$/.test(a));
      const deferred = changes.find((c) => c.mode === "data" && /aws_dynamodb_table_item\.routing/.test(c.address));
      let routingPrimary: string | null = null;
      let routingFormat: string | null = null;
      if (routingAddress !== undefined) {
        try {
          const item = obj(JSON.parse(String(priorDataResources(plan).get(routingAddress)?.item ?? "null")));
          routingPrimary = str(obj(item.primary_pool).S);
          routingFormat = str(obj(item.fmt).N);
        } catch {
          routingPrimary = null;
        }
      }
      checks.push(
        judge(
          `${label}: services gated on the bootstrap`,
          start === true && routingAddress !== undefined && deferred === undefined && routingFormat === "1" && routingPrimary === expect.primaryPool,
          `start_services = true; SYSTEM/ROUTING read at plan time: format 1, primary ${String(routingPrimary)}`,
          start !== true
            ? `services are planned while start_services = ${String(start)}`
            : deferred !== undefined
              ? "the routing read is deferred to apply: the plan could not evaluate the gate"
              : routingAddress === undefined
                ? "the plan read no SYSTEM/ROUTING"
                : `SYSTEM/ROUTING is format ${String(routingFormat)} naming ${String(routingPrimary)}, not ${expect.primaryPool}`,
        ),
      );
      const bad = services
        .filter((c) => !(c.after.deployment_minimum_healthy_percent === 0 && c.after.deployment_maximum_percent === 100 && typeof c.after.desired_count === "number" && c.after.desired_count <= 1 && c.after.availability_zone_rebalancing === "DISABLED"))
        .map((c) => `${c.address} (${String(c.after.deployment_minimum_healthy_percent)}/${String(c.after.deployment_maximum_percent)}, desired ${String(c.after.desired_count)}, AZ ${String(c.after.availability_zone_rebalancing)})`);
      checks.push(judge(`${label}: planned services stop-first`, bad.length === 0, `${services.length} service(s): 0/100, at most one task, AZ rebalancing DISABLED`, bad.join("; ")));
    }
  }
  return { checks, summary: { terraform_version: tfVersion, provider: String(selected ?? ""), exit, actions: summarize(changes), destructive: destructive.map((c) => `${c.address} [${c.actions.join(",")}]`) } };
}
