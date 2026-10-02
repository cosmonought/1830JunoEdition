// server/src/aws/deploy/migration/planGuards.ts
//
// ==================================================================
//  COST-2B: THE MIGRATION PLAN GUARDS -- EVERY DANGEROUS COST MIGRATION APPLY JUDGED FROM ITS SAVED PLAN, FAIL CLOSED
// ==================================================================
//
// infra/aws/SINGLE_HOST_MIGRATION.md moves staging from the drained ECS topology to the single host. Each Terraform step
// of it is applied ONLY after its saved plan (`infra/aws/scripts/plan-evidence`, `terraform show -json`) passed the
// guard for THAT step (`npm run awsDeploy -- migration-guard <gate> ...`). A guard is an ALLOWLIST, not a denylist:
//
//   every managed change that is not a no-op must match one of the gate's allow rules -- a create, update, replace,
//   delete or forget the gate does not name FAILS, whatever its type ("an unrecognized change in a critical category
//   fails closed"; here every category is critical). A value the plan cannot show (unknown until apply) where the gate
//   must judge it FAILS. A plan the guard cannot read FAILS.
//
// The named checks below exist so a failure says WHY in the operator's terms (the ledger table, a KMS key, APPGEN, the
// ECS desired-count drift, g2, ...); the allowlist is what makes the guard complete.
//
//   ledger-host-authorize    (step 8, stacks/ledger)  the ledger's resource policy and the signing keys' policies gain
//                            EXACTLY the host role gs-<env>-host-app beside the ECS task role, in exactly the runtime
//                            statements; nothing else in any policy moves; no table, key, backup or item changes.
//   host-create              (step 9, stacks/single-host) creates exactly the single-host surface -- one instance, one
//                            ENI, one EIP, the security group and its rules, the role / profile / inline policy, the log
//                            group, the five alarms and the budget -- and nothing else; the role reaches only g<serving>.
//   edge-cutover             (step 14, stacks/app, a TARGETED plan) the existing distribution's `gs-alb` origin changes its
//                            domain name to the named host origin (or back, for the rollback) -- nothing else of the
//                            distribution, nothing else in the stack.
//   ecs-rollback             (rollback before step 14, stacks/app) the primary pool's service goes from desired 0 to 1 --
//                            the ONLY plan that may start an ECS task again; the retired pool stays at 0.
//   compute-none             (step 20, stacks/app) destroys EXACTLY the ECS-era classes that exist in the prior state
//                            and narrows what referred to the retired pool; never a table, key, the p1 or Juno document,
//                            ECR, the distribution, the bootstrap / operator authority or the host.
//   ledger-task-deauthorize  (step 22, stacks/ledger) the mirror of the first gate: the task role leaves exactly the
//                            runtime statements, the host role stays.
//   ecr-lifecycle            (step 22b, stacks/single-host) attaches the lifecycle policy, keeping >= 20 images.
//
// THE LEGACY DESIRED-COUNT DRIFT (COST-2B): the app stack's state and configuration expect running services (the primary
// pool's `desired_count` must be 1 -- a variable validation), while live staging is deliberately drained 0/0/0. An ordinary
// app-stack plan therefore UPDATES aws_ecs_service.pool["p1"] desired 0 -> 1 (with start_services = true: the pool restarts
// and takes POOL#p1 back from the host) or DESTROYS the services (start_services = false). Every gate but `ecs-rollback`
// refuses any ECS service / task-definition / cluster change other than compute-none's destruction, and names the drift.
//
// g2 IS INERT: `gs-<env>-game-g2` was restored and prepared but never adopted (APPGEN is 1, no generation-2 history). No
// gate accepts a plan that imports, creates, names or grants a game table of any generation but the serving one.
//
// Pure: no I/O. The command (`migrationCommands.ts`) reads the plan-evidence files.

import type { Check } from "../deployVerify";

type Json = unknown;
type Obj = Record<string, Json>;

const obj = (value: Json): Obj => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : {});
const arr = (value: Json): Json[] => (Array.isArray(value) ? value : []);
const str = (value: Json): string | null => (typeof value === "string" ? value : null);

const pass = (name: string, detail: string): Check => ({ name, status: "pass", detail });
const fail = (name: string, detail: string): Check => ({ name, status: "fail", detail });
const judge = (name: string, ok: boolean, good: string, bad: string): Check => (ok ? pass(name, good) : fail(name, bad));

export const MIGRATION_GUARD_FORMAT = "18COSMOS/COST-2B-MIGRATION-GUARD/v1";

export const GATES = Object.freeze({
  "ledger-host-authorize": { stack: "ledger", step: "D 8" },
  "host-create": { stack: "single-host", step: "D 9" },
  "edge-cutover": { stack: "app", step: "G 14 (and its rollback)" },
  "ecs-rollback": { stack: "app", step: "F rollback (before G)" },
  "compute-none": { stack: "app", step: "I 20" },
  "ledger-task-deauthorize": { stack: "ledger", step: "I 22" },
  "ecr-lifecycle": { stack: "single-host", step: "I 22b" },
} as const);
export type GateName = keyof typeof GATES;
export type StackName = (typeof GATES)[GateName]["stack"];
export const GATE_NAMES = Object.freeze(Object.keys(GATES) as GateName[]);
export const isGateName = (value: string): value is GateName => Object.prototype.hasOwnProperty.call(GATES, value);

/** The root module call of each stack (stacks/<stack>/main.tf). */
export const STACK_MODULE: Readonly<Record<StackName, string>> = Object.freeze({ ledger: "module.ledger", app: "module.app", "single-host": "module.host" });

export interface MigrationContext {
  /** gs-<environment>-... */
  readonly environment: string;
  /** The app account (the host and task roles live there). */
  readonly appAccountId: string;
  /** The serving game-table generation: 1 (APPGEN 1; g2 is unadopted). */
  readonly servingGeneration: number;
  /** The pool the host serves (the primary): p1. */
  readonly pool: string;
  /** The pools the migration retires (their ECS service, target group, rule, log group and runtime document go): p2. */
  readonly retiredPools: readonly string[];
  /** edge-cutover: the domain the /gs* origin must point at after this plan (the host's origin name; the ALB's for the rollback). */
  readonly originDomain?: string;
  /** ecr-lifecycle: the fewest images the lifecycle policy may keep. */
  readonly minEcrKeepImages?: number;
  /** host-create: the app account's region, the ledger table's ARN and the three signing keys' ARNs -- the facts the host
   *  policy must name, given by the operator from the ledger stack's outputs / the Juno document, never taken from the
   *  plan's own variables (a plan could name another account's table and keys and render a matching policy). */
  readonly region?: string;
  readonly ledgerTableArn?: string;
  readonly signingKeyArns?: readonly string[];
}

/** The accepted post-abandonment staging facts the gates assume unless told otherwise. */
export const STAGING_DEFAULTS = Object.freeze({ servingGeneration: 1, pool: "p1", retiredPools: Object.freeze(["p2"]) as readonly string[], minEcrKeepImages: 20 });

export const hostRoleArn = (ctx: MigrationContext): string => `arn:aws:iam::${ctx.appAccountId}:role/gs-${ctx.environment}-host-app`;
export const taskRoleArn = (ctx: MigrationContext): string => `arn:aws:iam::${ctx.appAccountId}:role/gs-${ctx.environment}-app-task`;
const gameTableName = (ctx: MigrationContext, generation: number): string => `gs-${ctx.environment}-game-g${generation}`;

/* ------------------------------------------------------------------ */
/* The plan                                                             */
/* ------------------------------------------------------------------ */

export type ActionKind = "no-op" | "read" | "create" | "update" | "delete" | "replace" | "forget" | "unknown";

export interface PlannedChange {
  readonly address: string;
  readonly mode: string;
  readonly type: string;
  readonly name: string;
  readonly index: Json;
  readonly kind: ActionKind;
  readonly actions: readonly string[];
  readonly before: Obj;
  readonly after: Obj;
  readonly afterUnknown: Obj;
  readonly reason: string | null;
  readonly previousAddress: string | null;
  readonly importing: boolean;
  readonly moduleAddress: string | null;
  readonly providerName: string | null;
}

/** The address Terraform writes for (module, mode, type, name, index): what an entry's `address` must be. */
export function composedAddress(moduleAddress: string | null, mode: string, type: string, name: string, index: Json): string {
  const suffix = index === undefined || index === null ? "" : typeof index === "number" ? `[${index}]` : `[${JSON.stringify(index)}]`;
  return `${moduleAddress === null ? "" : `${moduleAddress}.`}${mode === "data" ? "data." : ""}${type}.${name}${suffix}`;
}

/**
 * JSON.parse that REFUSES duplicate object keys (JSON.parse keeps the last one silently; the service reading the same
 * text may keep the first). Throws on any malformed or ambiguous input.
 */
export function strictJsonParse(text: string): Json {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i += 1;
  };
  const fail = (what: string): never => {
    throw new Error(`${what} at ${i}`);
  };
  const value = (): Json => {
    ws();
    const c = text[i];
    if (c === "{") {
      i += 1;
      const out: Obj = {};
      const seen = new Set<string>();
      ws();
      if (text[i] === "}") {
        i += 1;
        return out;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("a key expected");
        const key = value() as string;
        if (seen.has(key)) fail(`duplicate key ${JSON.stringify(key)}`);
        seen.add(key);
        ws();
        if (text[i] !== ":") fail("':' expected");
        i += 1;
        out[key] = value();
        ws();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "}") {
          i += 1;
          return out;
        }
        fail("',' or '}' expected");
      }
    }
    if (c === "[") {
      i += 1;
      const out: Json[] = [];
      ws();
      if (text[i] === "]") {
        i += 1;
        return out;
      }
      for (;;) {
        out.push(value());
        ws();
        if (text[i] === ",") {
          i += 1;
          continue;
        }
        if (text[i] === "]") {
          i += 1;
          return out;
        }
        fail("',' or ']' expected");
      }
    }
    const m = /^(?:"(?:[^"\\\u0000-\u001f]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (m === null) fail("a value expected");
    i += m![0].length;
    return JSON.parse(m![0]) as Json;
  };
  const out = value();
  ws();
  if (i !== text.length) fail("trailing text");
  return out;
}
const strictParse = (text: Json): Json | undefined => {
  if (typeof text !== "string") return undefined;
  try {
    return strictJsonParse(text);
  } catch {
    return undefined;
  }
};

export function actionKind(actions: readonly string[]): ActionKind {
  const key = [...actions].sort().join(",");
  switch (key) {
    case "no-op":
      return "no-op";
    case "read":
      return "read";
    case "create":
      return "create";
    case "update":
      return "update";
    case "delete":
      return "delete";
    case "create,delete":
      return "replace";
    case "forget":
      return "forget";
    default:
      return "unknown";
  }
}

export function changesOf(plan: Json): PlannedChange[] {
  return arr(obj(plan).resource_changes)
    .map(obj)
    .map((rc) => {
      const change = obj(rc.change);
      const actions = arr(change.actions).map(String);
      return {
        address: String(rc.address),
        mode: String(rc.mode),
        type: String(rc.type),
        name: String(rc.name),
        index: rc.index,
        kind: actionKind(actions),
        actions,
        before: obj(change.before),
        after: obj(change.after),
        afterUnknown: obj(change.after_unknown),
        reason: str(rc.action_reason),
        previousAddress: str(rc.previous_address),
        importing: change.importing !== undefined && change.importing !== null,
        moduleAddress: str(rc.module_address),
        providerName: str(rc.provider_name),
      };
    });
}

/** Every resource of the plan's PRIOR state (managed and data), by address. */
export function priorResources(plan: Json): Map<string, { readonly mode: string; readonly type: string; readonly name: string; readonly index: Json; readonly values: Obj; readonly providerName: string | null }> {
  const out = new Map<string, { mode: string; type: string; name: string; index: Json; values: Obj; providerName: string | null }>();
  const walk = (module: Json): void => {
    for (const r of arr(obj(module).resources).map(obj)) out.set(String(r.address), { mode: String(r.mode), type: String(r.type), name: String(r.name), index: r.index, values: obj(r.values), providerName: str(r.provider_name) });
    for (const child of arr(obj(module).child_modules)) walk(child);
  };
  walk(obj(obj(obj(plan).prior_state).values).root_module);
  return out;
}

const hasPriorState = (plan: Json): boolean => Object.keys(obj(obj(obj(plan).prior_state).values)).length > 0;

/**
 * A root variable's value. A value given on the command line (`-var name=value`) is recorded in the plan as the RAW
 * STRING (`"false"`, `'["arn:..."]'`), a tfvars value as typed JSON: both read the same here. A string that looks like a
 * list or object but is not JSON (HCL such as `{ p1 = { primary = true } }`) stays a string, so every check on it FAILS
 * (closed): give such values in a tfvars file.
 */
export const variable = (plan: Json, name: string): Json => {
  const v = obj(obj(plan).variables)[name];
  if (v === undefined) return undefined;
  const value = obj(v).value;
  if (typeof value !== "string") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\s*[[{]/.test(value)) {
    try {
      return JSON.parse(value) as Json;
    } catch {
      return value;
    }
  }
  return value;
};
const hasVariable = (plan: Json, name: string): boolean => obj(obj(plan).variables)[name] !== undefined;

/* ------------------------------------------------------------------ */
/* Values                                                               */
/* ------------------------------------------------------------------ */

/** Canonical JSON (sorted keys) for deep equality. */
export function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const o = value as Obj;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}
const same = (a: Json, b: Json): boolean => canonical(a) === canonical(b);

/** Does an after_unknown entry mark anything unknown? */
export function anyUnknown(marker: Json): boolean {
  if (marker === true) return true;
  if (Array.isArray(marker)) return marker.some(anyUnknown);
  if (typeof marker === "object" && marker !== null) return Object.values(marker as Obj).some(anyUnknown);
  return false;
}

/**
 * The top-level attributes an in-place update changes (or leaves unknown). `computed`: attributes the provider recomputes
 * on any update (accepted whatever they become). Returns the attributes outside `computed` that differ or are unknown.
 */
export function changedAttributes(c: PlannedChange, computed: readonly string[] = []): { readonly changed: string[]; readonly unknown: string[] } {
  const keys = new Set([...Object.keys(c.before), ...Object.keys(c.after), ...Object.keys(c.afterUnknown)]);
  const changed: string[] = [];
  const unknown: string[] = [];
  for (const key of [...keys].sort()) {
    if (computed.includes(key)) continue;
    if (anyUnknown(c.afterUnknown[key])) unknown.push(key);
    else if (!same(c.before[key], c.after[key])) changed.push(key);
  }
  return { changed, unknown };
}

/** An update that may change ONLY `allowed` (plus `computed`): null, or why not. */
function onlyAttributes(c: PlannedChange, allowed: readonly string[], computed: readonly string[] = []): string | null {
  const { changed, unknown } = changedAttributes(c, computed);
  const unknownOther = unknown.filter((k) => !allowed.includes(k));
  const changedOther = changed.filter((k) => !allowed.includes(k));
  if (unknownOther.length > 0) return `unknown until apply (cannot be judged): ${unknownOther.join(", ")}`;
  if (changedOther.length > 0) return `also changes ${changedOther.join(", ")}`;
  const unknownAllowed = unknown.filter((k) => allowed.includes(k));
  if (unknownAllowed.length > 0) return `${unknownAllowed.join(", ")} unknown until apply (the guard must see the value)`;
  return null;
}

/* ------------------------------------------------------------------ */
/* IAM / resource / key policies                                        */
/* ------------------------------------------------------------------ */

interface Statement {
  readonly sid: string;
  readonly body: Obj; // normalised (lists sorted, singletons as lists)
}

const asList = (value: Json): string[] => (value === undefined || value === null ? [] : Array.isArray(value) ? value.map(String) : [String(value)]).slice().sort();

function normaliseStatement(s: Obj): Obj {
  const out: Obj = {};
  for (const [key, value] of Object.entries(s)) {
    if (key === "Action" || key === "NotAction" || key === "Resource" || key === "NotResource") out[key] = asList(value);
    else if (key === "Principal" || key === "NotPrincipal") {
      if (typeof value === "string") out[key] = value;
      else out[key] = Object.fromEntries(Object.entries(obj(value)).map(([k, v]) => [k, asList(v)]));
    } else if (key === "Condition") {
      out[key] = Object.fromEntries(Object.entries(obj(value)).map(([op, block]) => [op, Object.fromEntries(Object.entries(obj(block)).map(([k, v]) => [k, asList(v)]))]));
    } else out[key] = value;
  }
  return out;
}

/** A policy document's statements by Sid (null: unreadable, or a statement without a unique Sid -- cannot be matched). */
export function parsePolicy(text: Json): { readonly version: string | null; readonly statements: Map<string, Statement> } | null {
  const parsed = strictParse(text);
  if (parsed === undefined || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const doc = parsed as Obj;
  const statements = new Map<string, Statement>();
  const list = Array.isArray(doc.Statement) ? doc.Statement : doc.Statement === undefined ? [] : [doc.Statement];
  for (const raw of list.map(obj)) {
    const sid = str(raw.Sid);
    if (sid === null || sid === "" || statements.has(sid)) return null;
    statements.set(sid, { sid, body: normaliseStatement(raw) });
  }
  return { version: str(doc.Version), statements };
}

const PRINCIPAL_ARN = "aws:PrincipalArn";
const principalArns = (s: Obj): string[] => asList(obj(obj(s.Condition).ArnEquals)[PRINCIPAL_ARN]);
function withPrincipalArns(s: Obj, values: readonly string[]): Obj {
  const condition = obj(s.Condition);
  return { ...s, Condition: { ...condition, ArnEquals: { ...obj(condition.ArnEquals), [PRINCIPAL_ARN]: [...values].sort() } } };
}

/**
 * The ledger's resource policy or a signing key's policy, before -> after, must differ ONLY in the runtime statements'
 * `aws:PrincipalArn` list:
 *   add     every statement naming the task role gains exactly the host role (task role KEPT: coexistence);
 *   remove  every statement naming the host role loses exactly the task role (host role kept).
 * Every other statement byte-equal (normalised); no statement added, removed or re-sided. null = acceptable.
 */
export function runtimePrincipalDelta(beforeText: Json, afterText: Json, mode: "add" | "remove", ctx: MigrationContext): string | null {
  const host = hostRoleArn(ctx);
  const task = taskRoleArn(ctx);
  const before = parsePolicy(beforeText);
  const after = parsePolicy(afterText);
  if (before === null || after === null) return "the policy is unknown at plan time or unreadable (a statement without a unique Sid cannot be matched)";
  if (before.version !== after.version) return `the policy Version changes (${String(before.version)} -> ${String(after.version)})`;
  const sidsB = [...before.statements.keys()].sort();
  const sidsA = [...after.statements.keys()].sort();
  if (!same(sidsB, sidsA)) return `statements added or removed (before: ${sidsB.join(",")}; after: ${sidsA.join(",")})`;
  let changedCount = 0;
  for (const sid of sidsB) {
    const b = before.statements.get(sid)!.body;
    const a = after.statements.get(sid)!.body;
    const bArns = principalArns(b);
    if (mode === "add") {
      if (bArns.includes(task)) {
        const expected = withPrincipalArns(b, [...new Set([...bArns, host])]);
        if (!same(a, expected)) return `statement ${sid}: the only change allowed is ${host} added beside ${task} (got ${JSON.stringify(principalArns(a))}, or another field moved)`;
        if (!same(a, b)) changedCount += 1;
      } else if (!same(a, b)) return `statement ${sid} is not a runtime statement (it does not name ${task}) and must not change`;
    } else {
      if (bArns.includes(host)) {
        if (!bArns.includes(task) && same(a, b)) continue;
        const expected = withPrincipalArns(b, bArns.filter((arn) => arn !== task));
        if (!same(a, expected)) return `statement ${sid}: the only change allowed is ${task} removed while ${host} stays (got ${JSON.stringify(principalArns(a))}, or another field moved)`;
        if (!same(a, b)) changedCount += 1;
      } else if (!same(a, b)) return `statement ${sid} does not name ${host} and must not change`;
    }
  }
  for (const s of after.statements.values()) {
    const arns = principalArns(s.body);
    if (mode === "add" && arns.includes(host) && !arns.includes(task)) return `statement ${s.sid} names the host role without the task role (the ECS task's authority must stay during coexistence)`;
    if (mode === "remove" && arns.includes(task)) return `statement ${s.sid} still names the task role`;
  }
  if (changedCount === 0) return "no runtime statement changes (this is not the host-role change)";
  return null;
}

/* ------------------------------------------------------------------ */
/* The result                                                           */
/* ------------------------------------------------------------------ */

export interface GuardResult {
  readonly format: string;
  readonly gate: GateName;
  readonly stack: StackName;
  readonly verdict: "PASS" | "FAIL";
  readonly checks: readonly Check[];
  readonly summary: { readonly actions: Record<string, number>; readonly changes: readonly string[] };
}

/** An allow rule: does this change belong to the step? (null: yes; a string: it matched the rule's resource but is wrong). */
type AllowRule = (c: PlannedChange) => { readonly matched: boolean; readonly problem?: string };

const ECS_TYPES = ["aws_ecs_service", "aws_ecs_task_definition", "aws_ecs_cluster", "aws_ecs_capacity_provider", "aws_ecs_cluster_capacity_providers", "aws_appautoscaling_target", "aws_appautoscaling_policy"];
const AUTHORITY_TYPES = ["aws_dynamodb_table", "aws_dynamodb_resource_policy", "aws_dynamodb_table_item", "aws_dynamodb_global_table", "aws_dynamodb_table_replica"];
const KMS_TYPES = ["aws_kms_key", "aws_kms_key_policy", "aws_kms_grant", "aws_kms_alias", "aws_kms_replica_key", "aws_kms_external_key"];
const BACKUP_PREFIX = "aws_backup_";
const IAM_PREFIX = "aws_iam_";
const isKms = (c: PlannedChange): boolean => KMS_TYPES.includes(c.type);
const mutating = (c: PlannedChange): boolean => c.mode === "managed" && c.kind !== "no-op";
const label = (c: PlannedChange): string => `${c.address} [${c.actions.join(",")}]`;
const list = (cs: readonly PlannedChange[], max = 8): string => cs.slice(0, max).map(label).join("; ") + (cs.length > max ? `; ... (${cs.length} in all)` : "");

/** The moves Terraform may still show for the COST-1 `count` gate and L6-2's game-table key (modules/app/moved.tf, tables.tf). */
const KNOWN_MOVES: ReadonlyArray<readonly [string, string]> = [
  ["aws_lb.this", "aws_lb.this[0]"],
  ["aws_lb_listener.https", "aws_lb_listener.https[0]"],
  ["aws_lb_listener_rule.gs", "aws_lb_listener_rule.gs[0]"],
  ["aws_ecs_cluster.this", "aws_ecs_cluster.this[0]"],
  ["aws_iam_role.execution", "aws_iam_role.execution[0]"],
  ["aws_iam_role_policy.execution", "aws_iam_role_policy.execution[0]"],
  ["aws_iam_role.task", "aws_iam_role.task[0]"],
  ["aws_iam_role_policy.task", "aws_iam_role_policy.task[0]"],
  ["aws_security_group.alb", "aws_security_group.alb[0]"],
  ["aws_vpc_security_group_ingress_rule.alb_from_cloudfront", "aws_vpc_security_group_ingress_rule.alb_from_cloudfront[0]"],
  ["aws_vpc_security_group_egress_rule.alb_to_tasks", "aws_vpc_security_group_egress_rule.alb_to_tasks[0]"],
  ["aws_security_group.task", "aws_security_group.task[0]"],
  ["aws_vpc_security_group_ingress_rule.task_from_alb", "aws_vpc_security_group_ingress_rule.task_from_alb[0]"],
  ["aws_dynamodb_table.game", 'aws_dynamodb_table.game["1"]'],
];

/* ------------------------------------------------------------------ */
/* Checks every gate runs                                               */
/* ------------------------------------------------------------------ */

const AWS_PROVIDER_NAME = "registry.terraform.io/hashicorp/aws";
/** The top-level sections of `terraform show -json` of a plan (Terraform 1.9 .. 1.16) the guard reads or may ignore. */
export const PLAN_SECTIONS: readonly string[] = ["format_version", "terraform_version", "variables", "planned_values", "resource_drift", "resource_changes", "output_changes", "prior_state", "configuration", "relevant_attributes", "checks", "timestamp", "applyable", "complete", "errored", "deferred_changes"];
/** The data sources the three stacks read (all at plan time). */
export const ALLOWED_DATA_TYPES: readonly string[] = ["aws_partition", "aws_caller_identity", "aws_region", "aws_iam_policy_document", "aws_ec2_managed_prefix_list", "aws_dynamodb_table_item"];
/** The only reasons Terraform gives for a delete that the migration expects (count / for_each no longer produce it). */
export const DELETE_REASONS: readonly string[] = ["delete_because_count_index", "delete_because_each_key"];
const MODULE_SOURCE: Readonly<Record<StackName, string>> = { ledger: "../../modules/ledger", app: "../../modules/app", "single-host": "../../modules/single-host" };

/**
 * The plan's `configuration`: the stack root calls exactly its one module, from the repository's own path, with no
 * root-level resource and no nested module; every resource is managed or data (no ephemeral resource), none carries a
 * provisioner (a local-exec runs with the OPERATOR's credentials at create or destroy time), every data source is one the
 * stacks read; every provider is hashicorp/aws.
 */
export function configurationCheck(p: Obj, stack: StackName): Check {
  const name = "configuration: the stack's own module, nothing that runs code";
  const c = obj(p.configuration);
  if (Object.keys(c).length === 0) return fail(name, "the plan carries no configuration: the guard cannot see provisioners or data sources (capture with terraform show -json of a saved plan)");
  const problems: string[] = [];
  for (const [key, pc] of Object.entries(obj(c.provider_config))) if (obj(pc).full_name !== AWS_PROVIDER_NAME) problems.push(`provider ${key} = ${String(obj(pc).full_name)}`);
  const root = obj(c.root_module);
  if (arr(root.resources).length > 0) problems.push(`root-level resources: ${arr(root.resources).map((r) => String(obj(r).address)).join(", ")}`);
  const calls = obj(root.module_calls);
  const callName = STACK_MODULE[stack].slice("module.".length);
  if (!same(Object.keys(calls), [callName])) problems.push(`module calls ${JSON.stringify(Object.keys(calls))} (exactly ${callName})`);
  const call = obj(calls[callName]);
  if (call.source !== MODULE_SOURCE[stack]) problems.push(`module ${callName} from ${String(call.source)} (not ${MODULE_SOURCE[stack]})`);
  const walk = (module: Obj, at: string): void => {
    for (const r of arr(module.resources).map(obj)) {
      const addr = `${at}${String(r.address)}`;
      if (r.mode !== "managed" && r.mode !== "data") problems.push(`${addr}: mode ${String(r.mode)}`);
      if (r.provisioners !== undefined && arr(r.provisioners).length > 0) problems.push(`${addr}: provisioner(s) ${arr(r.provisioners).map((x) => String(obj(x).type)).join(", ")}`);
      if (r.mode === "data" && !ALLOWED_DATA_TYPES.includes(String(r.type))) problems.push(`${addr}: data source ${String(r.type)}`);
    }
    const nested = obj(module.module_calls);
    if (Object.keys(nested).length > 0 && at !== "") problems.push(`${at}: nested module calls ${Object.keys(nested).join(", ")}`);
    for (const [k, v] of Object.entries(nested)) walk(obj(obj(v).module), `module.${k}.`);
  };
  walk(root, "");
  return problems.length === 0 ? pass(name, `module.${callName} from ${MODULE_SOURCE[stack]}; hashicorp/aws only; no provisioner; data sources ${ALLOWED_DATA_TYPES.join(", ")} at most`) : fail(name, `${problems.slice(0, 8).join("; ")} (fail closed)`);
}

function commonChecks(gate: GateName, plan: Json, changes: readonly PlannedChange[], ctx: MigrationContext): Check[] {
  const checks: Check[] = [];
  const p = obj(plan);
  const stack = GATES[gate].stack;
  const prefix = `${STACK_MODULE[stack]}.`;

  checks.push(
    judge(
      "plan: a saved Terraform plan (terraform show -json)",
      typeof p.format_version === "string" && /^1\./.test(p.format_version) && p.errored !== true && p.applyable !== false && Array.isArray(p.resource_changes) && changes.length > 0,
      `format ${String(p.format_version)}, ${changes.length} resource entries`,
      p.errored === true ? "the plan errored" : p.applyable === false ? "Terraform says the plan is not applyable" : !Array.isArray(p.resource_changes) || changes.length === 0 ? "no resource_changes: not a plan of this stack, or nothing to apply" : `format_version ${String(p.format_version)} (1.x expected)`,
    ),
  );

  const foreign = changes.filter((c) => !c.address.startsWith(prefix));
  checks.push(judge(`plan: only ${STACK_MODULE[stack]} (stacks/${stack})`, foreign.length === 0, `every entry under ${STACK_MODULE[stack]}`, `entries outside this stack's module: ${list(foreign)}`));

  /* Every entry is what its address says (a forged address cannot borrow a harmless type), once, at this stack's root. */
  const seen = new Set<string>();
  const inconsistent: string[] = [];
  for (const c of changes) {
    if (c.moduleAddress !== STACK_MODULE[stack] || c.address !== composedAddress(c.moduleAddress, c.mode, c.type, c.name, c.index)) inconsistent.push(`${c.address} (module ${String(c.moduleAddress)}, ${c.mode} ${c.type}.${c.name} index ${JSON.stringify(c.index)})`);
    if (seen.has(c.address)) inconsistent.push(`${c.address} listed twice`);
    seen.add(c.address);
  }
  checks.push(judge("plan: every entry is what its address says, once", inconsistent.length === 0, `${changes.length} addresses consistent with module, mode, type, name and index; none repeated`, `${inconsistent.slice(0, 6).join("; ")} -- not a plan Terraform wrote (fail closed)`));

  /* Only the sections Terraform writes (any other -- a newer feature such as action invocations -- is not judged: refused). */
  const unknownSections = Object.keys(p).filter((k) => !PLAN_SECTIONS.includes(k));
  checks.push(judge("plan: only the sections the guard reads", unknownSections.length === 0, "format, variables, planned values, drift, changes, outputs, prior state, configuration, checks", `sections this guard does not judge (fail closed): ${unknownSections.join(", ")}`));

  /* The configuration: this stack's ONE module call, from the repository's module, nothing that runs code. */
  checks.push(configurationCheck(p, stack));

  /* Why each object goes. A genuine teardown deletes only what count / for_each no longer produce. An object deleted
     because its resource block is GONE ("no resource config") can be the target of a root `removed {}` block whose
     destroy-time provisioner runs with the operator's credentials -- and `terraform show -json` shows neither the block nor
     the provisioner (COST-2B review round 3, reproduced on Terraform 1.16.5). So: only those two reasons, and the
     resource must still be declared in the configuration. */
  const declared = new Set<string>();
  const callModule = obj(obj(obj(obj(obj(p.configuration).root_module).module_calls)[STACK_MODULE[stack].slice("module.".length)]).module);
  for (const r of arr(callModule.resources).map(obj)) declared.add(`${String(r.mode)}:${String(r.type)}.${String(r.name)}`);
  const badDeletes = changes.filter((c) => c.mode === "managed" && (c.kind === "delete" || c.kind === "forget") && (!DELETE_REASONS.includes(String(c.reason)) || !declared.has(`managed:${c.type}.${c.name}`)));
  checks.push(
    judge(
      "plan: every destroy is count / for_each shrinking a declared resource",
      badDeletes.length === 0,
      "each deleted object's resource is still declared; Terraform deletes it because count / for_each no longer produce it",
      `${badDeletes.map((c) => `${c.address} (${String(c.reason ?? "no reason")}${declared.has(`managed:${c.type}.${c.name}`) ? "" : ", its resource no longer declared"})`).slice(0, 6).join("; ")} -- a removed resource block may carry a destroy-time provisioner the plan does not show (fail closed)`,
    ),
  );

  /* A data source read at apply instead of plan: the plan cannot show what it returns, and some data sources RUN things. */
  const dataReads = changes.filter((c) => c.mode === "data");
  checks.push(judge("plan: every data source read at plan time", dataReads.length === 0, "no data source deferred to apply", `${list(dataReads)} -- read at apply time: the plan cannot show what it does (fail closed)`));
  const foreignProvider = [...changes.map((c) => c.providerName), ...[...priorResources(plan).values()].map((r) => r.providerName)].filter((n) => n !== AWS_PROVIDER_NAME);
  checks.push(judge("plan: hashicorp/aws only", foreignProvider.length === 0, "every change and state object belongs to hashicorp/aws", `objects of another provider: ${[...new Set(foreignProvider)].join(", ")}`));

  const deferred = arr(p.deferred_changes);
  checks.push(judge("plan: nothing deferred", deferred.length === 0, "no deferred change", `${deferred.length} deferred change(s): the plan cannot show what it will do`));

  const unknownActions = changes.filter((c) => c.kind === "unknown" || (c.mode === "data" && c.kind !== "read" && c.kind !== "no-op") || (c.mode !== "data" && c.mode !== "managed"));
  checks.push(judge("plan: every action understood", unknownActions.length === 0, "no-op / read / create / update / delete / replace / forget only", `actions this guard does not know (fail closed): ${list(unknownActions)}`));

  const imports = changes.filter((c) => c.importing);
  checks.push(judge("plan: nothing imported", imports.length === 0, "no import", `imports (a migration step imports nothing -- g2 stays outside Terraform): ${list(imports)}`));

  const moves = changes.filter((c) => c.previousAddress !== null);
  const badMoves = moves.filter((c) => {
    const from = c.previousAddress!.slice(prefix.length);
    const to = c.address.slice(prefix.length);
    return stack !== "app" || !c.previousAddress!.startsWith(prefix) || !KNOWN_MOVES.some(([f, t]) => f === from && t === to) || c.kind !== "no-op";
  });
  checks.push(
    judge(
      "plan: no unexpected move",
      badMoves.length === 0,
      moves.length === 0 ? "no move" : `${moves.length} known COST-1 / L6-2 address move(s), each a no-op`,
      `moves outside modules/app/moved.tf's set, or a move that also changes the object: ${badMoves.map((c) => `${String(c.previousAddress)} -> ${c.address} [${c.actions.join(",")}]`).join("; ")}`,
    ),
  );

  /* g2 is inert: no change, no grant, no variable reaches a game table of another generation. */
  const otherTables: string[] = [];
  const otherGen = new RegExp(`gs-${ctx.environment}-game-g(\\d+)`, "g");
  for (const c of changes) {
    if (c.type === "aws_dynamodb_table" && /\.game\[/.test(c.address) && !c.address.endsWith(`.game["${ctx.servingGeneration}"]`) && c.kind !== "no-op") otherTables.push(label(c));
    if (c.kind === "no-op") continue;
    const text = canonical(c.after);
    for (const m of text.matchAll(otherGen)) if (Number(m[1]) !== ctx.servingGeneration) otherTables.push(`${c.address} names ${m[0]}`);
  }
  const generations = variable(plan, "game_generations");
  if (Array.isArray(generations) && generations.some((g) => Number(g) !== ctx.servingGeneration)) otherTables.push(`game_generations = ${JSON.stringify(generations)}`);
  if (generations !== undefined && generations !== null && !Array.isArray(generations)) otherTables.push(`game_generations = ${JSON.stringify(generations)} cannot be read (give it in a tfvars file)`);
  if (hasVariable(plan, "generation") && Number(variable(plan, "generation")) !== ctx.servingGeneration) otherTables.push(`generation = ${String(variable(plan, "generation"))}`);
  checks.push(
    judge(
      `g${ctx.servingGeneration} serves; every other generation stays inert`,
      otherTables.length === 0,
      `nothing names a game table but ${gameTableName(ctx, ctx.servingGeneration)} (g2 unadopted, outside Terraform)`,
      `${[...new Set(otherTables)].slice(0, 6).join("; ")} -- APPGEN is ${ctx.servingGeneration}; an unadopted generation is never imported, granted or served by a migration step`,
    ),
  );
  return checks;
}

/** THE LEGACY DESIRED-COUNT DRIFT, named: an ECS change in a gate that must not touch ECS. */
function ecsUntouchedCheck(plan: Json, changes: readonly PlannedChange[]): Check {
  const ecs = changes.filter((c) => mutating(c) && ECS_TYPES.includes(c.type));
  const drifted = arr(obj(plan).resource_drift)
    .map(obj)
    .filter((d) => String(d.type) === "aws_ecs_service")
    .map((d) => `${String(d.address)} desired ${String(obj(obj(d.change).before).desired_count)} -> live ${String(obj(obj(d.change).after).desired_count)}`);
  const restarts = ecs.filter((c) => c.type === "aws_ecs_service" && (c.kind === "update" || c.kind === "create" || c.kind === "replace") && Number(c.after.desired_count) > 0);
  return judge(
    "ECS untouched (the legacy desired-count drift)",
    ecs.length === 0,
    drifted.length > 0 ? `no ECS change; the drift Terraform saw stays drift (${drifted.join("; ")})` : "no ECS change",
    `${restarts.length > 0 ? `this plan would RESTART ${restarts.map((c) => c.address).join(", ")} (live desired 0, the stack's configuration 1) and that task would take POOL#p1 back -- ` : ""}ECS changes: ${list(ecs)}${drifted.length > 0 ? ` (drift Terraform saw: ${drifted.join("; ")})` : ""}. Before the host cutover no ordinary app-stack apply is allowed: plan the cutover TARGETED (-target=module.app.aws_cloudfront_distribution.site[0]); only the ecs-rollback gate may start a task`,
  );
}

/** The allowlist: every managed non-no-op change must match a rule (and pass it). */
function allowlistCheck(changes: readonly PlannedChange[], rules: readonly AllowRule[], what: string): Check {
  const problems: string[] = [];
  let allowed = 0;
  for (const c of changes) {
    if (!mutating(c)) continue;
    let matched = false;
    for (const rule of rules) {
      const r = rule(c);
      if (!r.matched) continue;
      matched = true;
      if (r.problem !== undefined) problems.push(`${label(c)}: ${r.problem}`);
      else allowed += 1;
      break;
    }
    if (!matched) problems.push(`${label(c)}: NOT PART OF THIS STEP${critical(c) ? " (critical: " + critical(c) + ")" : ""}`);
  }
  return judge(`every change is one this step makes (${what})`, problems.length === 0, `${allowed} change(s), each allowed and checked`, problems.slice(0, 10).join(" | ") + (problems.length > 10 ? ` | ... (${problems.length})` : ""));
}

function critical(c: PlannedChange): string | null {
  if (AUTHORITY_TYPES.includes(c.type)) return "authoritative DynamoDB";
  if (isKms(c)) return "KMS";
  if (c.type.startsWith(BACKUP_PREFIX)) return "AWS Backup";
  if (c.type.startsWith(IAM_PREFIX)) return "IAM authority";
  if (c.type === "aws_ssm_parameter") return "runtime configuration";
  if (c.type.startsWith("aws_cloudfront_")) return "the edge";
  if (c.type.startsWith("aws_ecr_")) return "the image registry";
  if (ECS_TYPES.includes(c.type)) return "ECS";
  if (c.type.startsWith("aws_lb")) return "the ALB";
  if (c.type === "aws_instance" || c.type === "aws_eip" || c.type === "aws_eip_association" || c.type === "aws_network_interface") return "compute / addressing";
  if (c.type === "aws_nat_gateway" || c.type === "aws_vpc_endpoint") return "networking cost";
  return null;
}

const addressIs = (stackModule: string, local: string) => (c: PlannedChange) => c.address === `${stackModule}.${local}`;
const resourceIs = (stackModule: string, type: string, name: string) => (c: PlannedChange) => c.address.startsWith(`${stackModule}.`) && c.type === type && c.name === name && c.address.slice(stackModule.length + 1).startsWith(`${type}.${name}`);

function namedForbidden(name: string, changes: readonly PlannedChange[], predicate: (c: PlannedChange) => boolean, good: string, why: string): Check {
  const hit = changes.filter((c) => mutating(c) && predicate(c));
  return judge(name, hit.length === 0, good, `${list(hit)} -- ${why}`);
}

/* ------------------------------------------------------------------ */
/* Gate A / E: the ledger's runtime principals                          */
/* ------------------------------------------------------------------ */

function ledgerPrincipalGate(gate: "ledger-host-authorize" | "ledger-task-deauthorize", plan: Json, changes: readonly PlannedChange[], ctx: MigrationContext): Check[] {
  const m = STACK_MODULE.ledger;
  const mode = gate === "ledger-host-authorize" ? "add" : "remove";
  const checks: Check[] = [];
  const host = hostRoleArn(ctx);

  const runtimeArns = variable(plan, "app_runtime_role_arns");
  const taskAuthorized = variable(plan, "ecs_task_role_authorized");
  checks.push(
    judge(
      "variables: exactly the host role; the task role " + (mode === "add" ? "kept" : "removed"),
      same(runtimeArns, [host]) && taskAuthorized === (mode === "add"),
      `app_runtime_role_arns = [${host}], ecs_task_role_authorized = ${String(mode === "add")}`,
      `app_runtime_role_arns = ${JSON.stringify(runtimeArns)}, ecs_task_role_authorized = ${JSON.stringify(taskAuthorized)}`,
    ),
  );

  const policyRule = (match: (c: PlannedChange) => boolean): AllowRule => (c) => {
    if (!match(c)) return { matched: false };
    if (c.kind !== "update") return { matched: true, problem: `a ${c.kind}, not an in-place policy update` };
    const attrs = onlyAttributes(c, ["policy"], ["revision_id"]);
    if (attrs !== null) return { matched: true, problem: attrs };
    const delta = runtimePrincipalDelta(c.before.policy, c.after.policy, mode, ctx);
    return delta === null ? { matched: true } : { matched: true, problem: delta };
  };
  checks.push(allowlistCheck(changes, [policyRule(addressIs(m, "aws_dynamodb_resource_policy.ledger")), policyRule(resourceIs(m, "aws_kms_key", "signing"))], mode === "add" ? "the host role ADDED to the runtime statements" : "the task role REMOVED from the runtime statements"));

  const resourcePolicy = changes.find(addressIs(m, "aws_dynamodb_resource_policy.ledger"));
  checks.push(judge("the ledger's resource policy changes", resourcePolicy?.kind === "update", "aws_dynamodb_resource_policy.ledger: update in place", resourcePolicy === undefined ? "the plan does not contain the ledger's resource policy (a targeted or foreign plan?)" : `aws_dynamodb_resource_policy.ledger is ${resourcePolicy.kind}`));
  /* EVERY signing key the state holds -- not only those the plan chose to show (a -target can leave one out). */
  const byAddress = new Map(changes.map((c) => [c.address, c] as const));
  const stateKeys = [...priorResources(plan).entries()].filter(([a, r]) => r.mode === "managed" && r.type === "aws_kms_key" && r.name === "signing" && a.startsWith(`${m}.`)).map(([a]) => a);
  const keysNotUpdated = stateKeys.filter((a) => byAddress.get(a)?.kind !== "update").map((a) => `${a} [${byAddress.get(a)?.kind ?? "not in the plan"}]`);
  checks.push(
    judge(
      "every signing key's policy changes with it",
      hasPriorState(plan) && keysNotUpdated.length === 0,
      `${stateKeys.length} key polic${stateKeys.length === 1 ? "y" : "ies"} of the state, each updated in place`,
      !hasPriorState(plan)
        ? "the plan carries no prior_state: the guard cannot see which signing keys exist"
        : `${keysNotUpdated.join("; ")} -- ${mode === "add" ? "the host would be refused Sign / GetPublicKey with this key (F3/F5 would fail)" : "this key would keep authorising the retired task role"}`,
    ),
  );

  checks.push(namedForbidden("the ledger table: never replaced, destroyed or changed", changes, (c) => c.type === "aws_dynamodb_table", "aws_dynamodb_table.ledger unchanged", "the ledger is the money authority"));
  checks.push(namedForbidden("KMS: no key created, destroyed or replaced", changes, (c) => isKms(c) && c.kind !== "update", "only in-place key-policy updates", "a signing key IS a relayer / settlement / admission identity"));
  checks.push(namedForbidden("APPGEN: never a Terraform item", changes, (c) => c.type === "aws_dynamodb_table_item", "no aws_dynamodb_table_item", "APPGEN / APPGEN#HISTORY are the bootstrap's and the recovery's, never Terraform's (APPGEN stays 1)"));
  checks.push(namedForbidden("AWS Backup: untouched", changes, (c) => c.type.startsWith(BACKUP_PREFIX) || addressIs(m, "aws_iam_role.backup")(c) || addressIs(m, "aws_iam_role_policy_attachment.backup")(c), "the vault, its lock and policy, the plan and the selection unchanged", "the ledger's separate durability boundary"));
  return checks;
}

/* ------------------------------------------------------------------ */
/* Gate B: host-create                                                  */
/* ------------------------------------------------------------------ */

export const HOST_SINGLETONS = [
  "aws_instance.host",
  "aws_network_interface.host",
  "aws_eip.host",
  "aws_eip_association.host",
  "aws_security_group.host",
  "aws_vpc_security_group_ingress_rule.https_from_cloudfront",
  "aws_vpc_security_group_ingress_rule.acme_http01",
  "aws_iam_role.host",
  "aws_iam_instance_profile.host",
  "aws_iam_role_policy.host",
  "aws_cloudwatch_log_group.host",
  "aws_cloudwatch_metric_alarm.health",
  "aws_cloudwatch_metric_alarm.critical",
  "aws_cloudwatch_metric_alarm.status_check",
  "aws_cloudwatch_metric_alarm.pressure",
  "aws_cloudwatch_metric_alarm.cpu_credits",
  "aws_budgets_budget.monthly[0]",
];
/** The five host alarms: [resource name, namespace, metric, dimensions]. */
const HOST_ALARMS: ReadonlyArray<readonly [string, string, string, "environment" | "instance"]> = [
  ["health", "18Cosmos/GameServer", "HostHealthProblems", "environment"],
  ["critical", "18Cosmos/GameServer", "HostCriticalEvents", "environment"],
  ["pressure", "18Cosmos/Host", "HostPressure", "environment"],
  ["status_check", "AWS/EC2", "StatusCheckFailed", "instance"],
  ["cpu_credits", "AWS/EC2", "CPUCreditBalance", "instance"],
];

export const HOST_MULTI = [
  ["aws_vpc_security_group_ingress_rule", "emergency_ssh"],
  ["aws_vpc_security_group_egress_rule", "https"],
] as const;

/** Actions the host's role must never hold (diagnostics only: the decisive rule is the exact match below). Lower-cased:
 *  IAM matches action names case-insensitively. */
const HOST_FORBIDDEN_ACTIONS: readonly RegExp[] = [
  /\*/,
  /\?/,
  /^(iam|sts|organizations|secretsmanager|cloudfront|ecs|elasticloadbalancing|backup|ec2|route53|s3|lambda|sqs|sns):/,
  /^dynamodb:(?!getitem$|query$|scan$|conditioncheckitem$|putitem$|updateitem$|deleteitem$)/,
  /^kms:(?!sign$|getpublickey$)/,
  /^ssm:(?!getparameter$|updateinstanceinformation$|listinstanceassociations$)/,
  /^ecr:(?!getauthorizationtoken$|batchchecklayeravailability$|getdownloadurlforlayer$|batchgetimage$)/,
  /^logs:(?!createlogstream$|putlogevents$)/,
];
const UNSCOPABLE_STAR_ACTIONS = new Set(["ecr:getauthorizationtoken", "cloudwatch:putmetricdata", "ssmmessages:createcontrolchannel", "ssmmessages:createdatachannel", "ssmmessages:opencontrolchannel", "ssmmessages:opendatachannel", "ec2messages:acknowledgemessage", "ec2messages:deletemessage", "ec2messages:failmessage", "ec2messages:getendpoint", "ec2messages:getmessages", "ec2messages:sendreply"]);

/**
 * The host role's inline policy EXACTLY as modules/single-host/iam.tf renders it for this plan's own variables (region,
 * pool, generation(s), ledger ARN, signing keys, escrow, ECR repository, SSM agent) and the gate's account: Sid -> the
 * normalised statement. null when a variable the policy depends on is missing or unreadable (fail closed).
 */
export function expectedHostPolicy(plan: Json, ctx: MigrationContext): Map<string, Obj> | null {
  const region = variable(plan, "region");
  const pool = variable(plan, "pool");
  const ledger = variable(plan, "ledger_table_arn");
  const keys = variable(plan, "signing_keys");
  const escrow = variable(plan, "escrow_enabled");
  const ssmAgent = variable(plan, "ssm_agent");
  const repoVar = variable(plan, "ecr_repository_name");
  const gensVar = variable(plan, "game_generations");
  if (typeof region !== "string" || typeof pool !== "string" || typeof ledger !== "string" || typeof escrow !== "boolean" || typeof ssmAgent !== "boolean") return null;
  if (keys !== null && (typeof keys !== "object" || Array.isArray(keys))) return null;
  /* The facts come from the OPERATOR (the ledger stack's outputs), never from the plan alone. */
  if (ctx.region === undefined || ctx.ledgerTableArn === undefined || ctx.signingKeyArns === undefined) return null;
  if (region !== ctx.region || ledger !== ctx.ledgerTableArn) return null;
  if (keys !== null && !same(Object.values(keys as Obj).map(String).sort(), [...ctx.signingKeyArns].sort())) return null;
  if (repoVar !== null && repoVar !== undefined && repoVar !== `gs-${ctx.environment}-server`) return null;
  if (gensVar !== null && gensVar !== undefined && !Array.isArray(gensVar)) return null;
  const a = ctx.appAccountId;
  const e = ctx.environment;
  const gens = [...new Set([ctx.servingGeneration, ...arr(gensVar).map(Number)])].map(String).sort();
  const gameArns = gens.map((g) => `arn:aws:dynamodb:${region}:${a}:table/gs-${e}-game-g${g}`).sort();
  const keyArns = keys === null ? [] : Object.values(keys as Obj).map(String);
  const repo = typeof repoVar === "string" ? repoVar : `gs-${e}-server`;
  const statements: Obj[] = [
    { Sid: "GameTableReadAndCheck", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:ConditionCheckItem"], Resource: gameArns },
    { Sid: "GameTableWriteNeverSystem", Effect: "Allow", Action: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"], Resource: gameArns, Condition: { "ForAllValues:StringNotEquals": { "dynamodb:LeadingKeys": ["SYSTEM"] } } },
    { Sid: "IdentityTable", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Scan", "dynamodb:ConditionCheckItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"], Resource: [`arn:aws:dynamodb:${region}:${a}:table/gs-${e}-identity`] },
    { Sid: "LedgerReadAndCheck", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"], Resource: [ledger] },
    { Sid: "LedgerAppendNeverAppgen", Effect: "Allow", Action: ["dynamodb:PutItem"], Resource: [ledger], Condition: { "ForAllValues:StringNotEquals": { "dynamodb:LeadingKeys": ["APPGEN", "APPGEN#HISTORY"] } } },
    { Sid: "ReadRuntimeConfiguration", Effect: "Allow", Action: ["ssm:GetParameter"], Resource: [`arn:aws:ssm:${region}:${a}:parameter/gs/${e}/runtime/${pool}`, ...(escrow ? [`arn:aws:ssm:${region}:${a}:parameter/gs/${e}/juno-backend`] : [])] },
    ...(keys === null
      ? []
      : [
          { Sid: "SigningKeysPublicKey", Effect: "Allow", Action: ["kms:GetPublicKey"], Resource: keyArns },
          { Sid: "SigningKeysSignDigestOnly", Effect: "Allow", Action: ["kms:Sign"], Resource: keyArns, Condition: { StringEquals: { "kms:SigningAlgorithm": "ECDSA_SHA_256", "kms:MessageType": "DIGEST" } } },
        ]),
    { Sid: "EcrAuthTokenUnscopable", Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: ["*"] },
    { Sid: "PullThisRepositoryOnly", Effect: "Allow", Action: ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], Resource: [`arn:aws:ecr:${region}:${a}:repository/${repo}`] },
    { Sid: "WriteThisHostLogsOnly", Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: [`arn:aws:logs:${region}:${a}:log-group:/gs/${e}/host:log-stream:*`] },
    { Sid: "HostPressureMetricOnly", Effect: "Allow", Action: ["cloudwatch:PutMetricData"], Resource: ["*"], Condition: { StringEquals: { "cloudwatch:namespace": "18Cosmos/Host" } } },
    ...(ssmAgent
      ? [
          { Sid: "SsmAgentRegister", Effect: "Allow", Action: ["ssm:UpdateInstanceInformation", "ssm:ListInstanceAssociations"], Resource: [`arn:aws:ec2:${region}:${a}:instance/*`] },
          {
            Sid: "SsmAgentChannelsUnscopable",
            Effect: "Allow",
            Action: ["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel", "ec2messages:AcknowledgeMessage", "ec2messages:DeleteMessage", "ec2messages:FailMessage", "ec2messages:GetEndpoint", "ec2messages:GetMessages", "ec2messages:SendReply"],
            Resource: ["*"],
          },
        ]
      : []),
  ];
  return new Map(statements.map((st) => [String(st.Sid), normaliseStatement(st)] as const));
}

/** The host role's inline policy: EXACTLY the expected statements (plus readable diagnostics). null: acceptable. */
export function hostPolicyProblem(policyText: Json, ctx: MigrationContext, plan: Json): string | null {
  const policy = parsePolicy(policyText);
  if (policy === null) return "the host role's policy is unknown at plan time, unreadable or ambiguous (a duplicate key, a statement without a unique Sid)";
  const problems: string[] = [];
  const serving = gameTableName(ctx, ctx.servingGeneration);
  const tableRe = /:table\/([^/]+)/;
  /* Diagnostics, so a refusal says why in the operator's terms. */
  for (const s of policy.statements.values()) {
    const b = s.body;
    if (String(b.Effect).toLowerCase() !== "allow") continue;
    if (b.NotAction !== undefined || b.NotResource !== undefined || b.NotPrincipal !== undefined) problems.push(`${s.sid}: NotAction / NotResource`);
    const actions = asList(b.Action);
    const lower = actions.map((x) => x.toLowerCase());
    actions.forEach((x, i) => {
      if (HOST_FORBIDDEN_ACTIONS.some((re) => re.test(lower[i]))) problems.push(`${s.sid}: ${x}`);
    });
    const resources = asList(b.Resource);
    if (resources.includes("*") && lower.some((x) => !UNSCOPABLE_STAR_ACTIONS.has(x))) problems.push(`${s.sid}: Resource "*" for a scopable action`);
    for (const r of resources) {
      const t = tableRe.exec(r)?.[1];
      if (t === undefined) continue;
      if (/[*?]/.test(t)) problems.push(`${s.sid}: a wildcard table resource ${r}`);
      else if (t !== serving && t !== `gs-${ctx.environment}-identity` && t !== `gs-${ctx.environment}-ledger`) problems.push(`${s.sid}: reaches table ${t} (only ${serving}, the identity table and the ledger)`);
    }
    const tables = resources.map((r) => tableRe.exec(r)?.[1]).filter((t): t is string => t !== undefined);
    const writes = lower.filter((x) => /^dynamodb:(putitem|updateitem|deleteitem|batchwriteitem|partiql(insert|update|delete))$/.test(x));
    const excluded = asList(obj(obj(b.Condition)["ForAllValues:StringNotEquals"])["dynamodb:LeadingKeys"]);
    if (writes.length > 0 && tables.includes(serving) && !excluded.includes("SYSTEM")) problems.push(`${s.sid}: writes the game table without excluding SYSTEM/* (routing, generation marker)`);
    if (writes.length > 0 && tables.includes(`gs-${ctx.environment}-ledger`)) {
      if (writes.some((x) => x !== "dynamodb:putitem")) problems.push(`${s.sid}: a ledger write other than PutItem`);
      if (!excluded.includes("APPGEN") || !excluded.includes("APPGEN#HISTORY")) problems.push(`${s.sid}: a ledger append that does not exclude APPGEN and APPGEN#HISTORY`);
    }
    if (lower.includes("kms:sign")) {
      const eq = obj(obj(b.Condition).StringEquals);
      if (!same(asList(eq["kms:MessageType"]), ["DIGEST"]) || !same(asList(eq["kms:SigningAlgorithm"]), ["ECDSA_SHA_256"])) problems.push(`${s.sid}: kms:Sign without the DIGEST / ECDSA_SHA_256 conditions`);
    }
  }
  /* The decisive rule: statement for statement, the module's rendering for these variables -- nothing more, nothing less. */
  const expected = expectedHostPolicy(plan, ctx);
  if (expected === null)
    problems.push(
      `the host policy's inputs do not match: region ${JSON.stringify(variable(plan, "region"))} / ${String(ctx.region)}, ledger_table_arn ${JSON.stringify(variable(plan, "ledger_table_arn"))} / ${String(ctx.ledgerTableArn)}, signing_keys ${canonical(variable(plan, "signing_keys"))} / ${canonical(ctx.signingKeyArns ?? null)}, ecr_repository_name ${JSON.stringify(variable(plan, "ecr_repository_name"))} (the plan's variables must name exactly the ledger and keys the operator gave: --region, --ledger-table-arn, --signing-keys)`,
    );
  else {
    if (policy.version !== "2012-10-17") problems.push(`Version ${String(policy.version)}`);
    const extra = [...policy.statements.keys()].filter((sid) => !expected.has(sid));
    const missing = [...expected.keys()].filter((sid) => !policy.statements.has(sid));
    const differ = [...expected.keys()].filter((sid) => policy.statements.has(sid) && !same(policy.statements.get(sid)!.body, expected.get(sid)));
    if (extra.length > 0) problems.push(`statements the module does not render: ${extra.join(", ")}`);
    if (missing.length > 0) problems.push(`statements missing: ${missing.join(", ")}`);
    if (differ.length > 0) problems.push(`statements that differ from the module's rendering: ${differ.join(", ")}`);
  }
  return problems.length === 0 ? null : [...new Set(problems)].slice(0, 10).join("; ");
}

/** The host role's trust policy: EC2 of this account only, exactly. */
export function hostTrustProblem(text: Json, ctx: MigrationContext): string | null {
  const p = parsePolicy(text);
  if (p === null) return "the role's trust policy is unknown, unreadable or ambiguous";
  const expected = normaliseStatement({ Sid: "Ec2ThisAccountOnly", Effect: "Allow", Action: "sts:AssumeRole", Principal: { Service: "ec2.amazonaws.com" }, Condition: { StringEquals: { "aws:SourceAccount": ctx.appAccountId } } });
  return p.version === "2012-10-17" && p.statements.size === 1 && same(p.statements.get("Ec2ThisAccountOnly")?.body, expected) ? null : "the role's trust policy is not exactly EC2 of this account (another principal could assume the role the ledger and the keys admit)";
}

function hostCreateGate(plan: Json, changes: readonly PlannedChange[], ctx: MigrationContext): Check[] {
  const m = STACK_MODULE["single-host"];
  const checks: Check[] = [];
  const createOnly = (match: (c: PlannedChange) => boolean, extra?: (c: PlannedChange) => string | null): AllowRule => (c) => {
    if (!match(c)) return { matched: false };
    if (c.kind !== "create") return { matched: true, problem: `a ${c.kind}: the host stack is NEW -- this step only creates` };
    const p = extra?.(c) ?? null;
    return p === null ? { matched: true } : { matched: true, problem: p };
  };
  const role = `gs-${ctx.environment}-host-app`;
  const rules: AllowRule[] = [
    createOnly(addressIs(m, "aws_instance.host"), (c) => {
      const md = obj(arr(c.after.metadata_options)[0]);
      if (md.http_tokens !== "required") return "IMDSv2 is not required (metadata_options.http_tokens)";
      if (typeof md.http_put_response_hop_limit !== "number" || md.http_put_response_hop_limit > 2) return `the IMDS hop limit is ${String(md.http_put_response_hop_limit)} (<= 2)`;
      if (arr(c.after.network_interface).length > 0 || arr(c.after.primary_network_interface).length !== 1) return "not on the module's ENI";
      if (c.after.iam_instance_profile !== role) return `the instance profile is ${String(c.after.iam_instance_profile)}, not ${role}`;
      if (c.after.key_name !== undefined && c.after.key_name !== null && c.after.key_name !== "") return "an SSH key pair is set";
      if (c.after.disable_api_termination !== true) return "termination protection is off";
      /* The module's cloud-init (base64gzip of its templates) depends on apply-time values, so a genuine plan shows it
         unknown; its content is the committed module's (the evidence's clean-checkout check). A value the plan SHOWS is not
         the module's rendering and cannot be judged here: refused. */
      for (const k of ["user_data", "user_data_base64"]) if (typeof c.after[k] === "string" && c.after[k] !== "") return `${k} is known at plan time (not the module's cloud-init, which depends on apply-time values): it cannot be judged`;
      return null;
    }),
    createOnly(addressIs(m, "aws_iam_role.host"), (c) => {
      if (c.after.name !== role) return `the role is named ${String(c.after.name)}, not ${role} (the only name the ledger admits)`;
      const trust = hostTrustProblem(c.after.assume_role_policy, ctx);
      if (trust !== null) return trust;
      /* inline_policy / managed_policy_arns are unknown when the configuration does not set them (they are read back from
         AWS); any VALUE present is the configuration attaching authority beside the judged inline policy (judged whatever
         after_unknown claims: a value and an "unknown" flag together is not a plan to trust). */
      if (arr(c.after.managed_policy_arns).length > 0) return `managed policies attached: ${JSON.stringify(c.after.managed_policy_arns)}`;
      if (arr(c.after.inline_policy).some((x) => Object.keys(obj(x)).length > 0 && (obj(x).name || obj(x).policy))) return "an inline_policy block beside aws_iam_role_policy.host";
      if (c.after.permissions_boundary !== undefined && c.after.permissions_boundary !== null && c.after.permissions_boundary !== "") return "a permissions boundary (not the module's)";
      return null;
    }),
    createOnly(addressIs(m, "aws_iam_instance_profile.host"), (c) => (c.after.name === role && c.after.role === role ? null : `the instance profile wraps ${String(c.after.role)} (named ${String(c.after.name)}), not ${role}`)),
    createOnly(addressIs(m, "aws_iam_role_policy.host"), (c) => {
      if (c.after.role !== undefined && c.after.role !== null && c.after.role !== role) return `the policy is attached to ${String(c.after.role)}, not ${role}`;
      return hostPolicyProblem(c.after.policy, ctx, plan);
    }),
    createOnly(addressIs(m, "aws_network_interface.host"), (c) => {
      if (c.after.subnet_id !== obj(variable(plan, "network")).subnet_id) return `the ENI is in ${String(c.after.subnet_id)}, not network.subnet_id`;
      if (c.after.source_dest_check !== true) return "source/destination check off";
      if (arr(c.after.security_groups).length > 0) return `the ENI names existing security groups ${JSON.stringify(c.after.security_groups)} (only the new host SG, unknown until apply)`;
      return null;
    }),
    createOnly(addressIs(m, "aws_eip_association.host"), (c) => {
      for (const k of ["instance_id", "allocation_id", "network_interface_id", "private_ip_address"]) if (c.after[k] !== undefined && c.after[k] !== null && c.after[k] !== "") return `the association names an existing ${k} ${String(c.after[k])} (only the new EIP and ENI)`;
      return null;
    }),
    createOnly(addressIs(m, "aws_cloudwatch_log_group.host"), (c) => (c.after.name === `/gs/${ctx.environment}/host` && (c.after.kms_key_id === undefined || c.after.kms_key_id === null || c.after.kms_key_id === "") ? null : `the log group is ${String(c.after.name)} (/gs/${ctx.environment}/host, no KMS key)`)),
    createOnly(addressIs(m, "aws_budgets_budget.monthly[0]"), (c) => (c.after.budget_type === "COST" && c.after.time_unit === "MONTHLY" && Number(c.after.limit_amount) > 0 && Number(c.after.limit_amount) <= 30 ? null : `the budget is ${String(c.after.budget_type)} ${String(c.after.time_unit)} ${String(c.after.limit_amount)} (COST, MONTHLY, <= $30)`)),
    ...HOST_ALARMS.map(([local, namespace, metric, dims]) =>
      createOnly(addressIs(m, `aws_cloudwatch_metric_alarm.${local}`), (c) => {
        const actions = arr(variable(plan, "alarm_action_arns")).map(String).sort();
        for (const k of ["alarm_actions", "ok_actions"]) if (!same(arr(c.after[k]).map(String).sort(), actions)) return `${k} ${JSON.stringify(c.after[k])} (exactly alarm_action_arns)`;
        if (arr(c.after.insufficient_data_actions).length > 0) return "insufficient_data_actions set";
        if (c.after.namespace !== namespace || c.after.metric_name !== metric) return `watches ${String(c.after.namespace)}/${String(c.after.metric_name)} (not ${namespace}/${metric})`;
        const d = obj(c.after.dimensions);
        if (dims === "environment" ? !same(d, { Environment: ctx.environment }) : Object.keys(d).some((k) => k !== "InstanceId") || (d.InstanceId !== undefined && d.InstanceId !== null)) return `dimensions ${canonical(d)} (${dims === "environment" ? `{Environment: ${ctx.environment}}` : "the new instance's id only"})`;
        return null;
      }),
    ),
    createOnly(addressIs(m, "aws_security_group.host"), (c) => {
      for (const k of ["ingress", "egress"]) if (arr(c.after[k]).length > 0) return `inline ${k} rules on the security group (the module uses only its separate rules)`;
      return null;
    }),
    createOnly(resourceIs(m, "aws_vpc_security_group_egress_rule", "https"), (c) => {
      const ports = [443, ...arr(obj(variable(plan, "network")).juno_egress_ports).map(Number)];
      return c.after.ip_protocol === "tcp" && c.after.from_port === c.after.to_port && ports.includes(Number(c.after.from_port)) ? null : `egress ${String(c.after.ip_protocol)} ${String(c.after.from_port)}-${String(c.after.to_port)} (tcp 443 / the Juno ports only)`;
    }),
    createOnly(addressIs(m, "aws_eip.host"), (c) => (c.after.domain === "vpc" ? null : "the Elastic IP is not domain vpc")),
    createOnly(addressIs(m, "aws_vpc_security_group_ingress_rule.https_from_cloudfront"), (c) =>
      c.after.from_port === 443 && c.after.to_port === 443 && c.after.ip_protocol === "tcp" && typeof c.after.prefix_list_id === "string" && c.after.cidr_ipv4 == null && c.after.cidr_ipv6 == null ? null : "443 is admitted only from CloudFront's origin-facing prefix list",
    ),
    createOnly(addressIs(m, "aws_vpc_security_group_ingress_rule.acme_http01"), (c) => (c.after.from_port === 80 && c.after.to_port === 80 && c.after.ip_protocol === "tcp" ? null : "the ACME rule admits port 80 only")),
    createOnly(resourceIs(m, "aws_vpc_security_group_ingress_rule", "emergency_ssh"), () => "emergency SSH is not opened by the migration's host creation (emergency_ssh_cidrs = []; it is its own reviewed change)"),
    /* every singleton has its own attribute rule above: none is accepted on its address alone */
  ];
  checks.push(allowlistCheck(changes, rules, "exactly the single-host surface, created"));

  const present = (local: string) => changes.some((c) => c.address === `${m}.${local}` && (c.kind === "create" || c.kind === "no-op"));
  const missing = HOST_SINGLETONS.filter((a) => !present(a));
  checks.push(judge("the whole surface is in the plan (budget included)", missing.length === 0, `${HOST_SINGLETONS.length} singletons: the host, its ENI / EIP, SG, role, profile, policy, log group, five alarms and the budget`, `missing: ${missing.join(", ")}${missing.includes("aws_budgets_budget.monthly[0]") ? " (the budget is REQUIRED at migration: budget.enabled with an owner-named subscriber)" : ""}`));
  const instances = changes.filter((c) => c.mode === "managed" && c.type === "aws_instance" && c.kind !== "delete");
  const eips = changes.filter((c) => c.mode === "managed" && c.type === "aws_eip" && c.kind !== "delete");
  checks.push(judge("one host, one Elastic IP", instances.length === 1 && eips.length === 1, "exactly one aws_instance and one aws_eip", `${instances.length} instance(s) (${instances.map((c) => c.address).join(", ")}), ${eips.length} Elastic IP(s) (${eips.map((c) => c.address).join(", ")}) -- a second host would fence the first (the pool writer) and a second EIP costs`));
  const banned = changes.filter((c) => mutating(c) && (AUTHORITY_TYPES.includes(c.type) || isKms(c) || ECS_TYPES.includes(c.type) || c.type.startsWith("aws_lb") || c.type === "aws_nat_gateway" || c.type === "aws_vpc_endpoint" || c.type.startsWith("aws_cloudfront_") || c.type === "aws_ecr_repository" || c.type === "aws_ecr_lifecycle_policy" || c.type.startsWith(BACKUP_PREFIX) || c.type === "aws_ssm_parameter"));
  checks.push(judge("no authority, ECS-era or duplicate resource", banned.length === 0, "no table, key, ALB, ECS, NAT, endpoint, distribution, ECR repository or lifecycle policy, SSM document or backup", `${list(banned)} -- the host REFERENCES the existing authorities; the ECR lifecycle waits for step 22b (ECS's rollback images must not expire)`));

  const vars: string[] = [];
  if (variable(plan, "pool") !== ctx.pool) vars.push(`pool = ${JSON.stringify(variable(plan, "pool"))}`);
  if (variable(plan, "manage_ecr_lifecycle") !== false) vars.push(`manage_ecr_lifecycle = ${JSON.stringify(variable(plan, "manage_ecr_lifecycle"))}`);
  if (obj(variable(plan, "budget")).enabled !== true) vars.push("budget.enabled is not true");
  checks.push(judge("variables: one pool, no lifecycle yet, the budget on", vars.length === 0, `pool ${ctx.pool}, manage_ecr_lifecycle false, budget enabled`, vars.join("; ")));
  return checks;
}

/* ------------------------------------------------------------------ */
/* Gate C: edge-cutover                                                 */
/* ------------------------------------------------------------------ */

/** Distribution attributes CloudFront recomputes on any update. */
const DISTRIBUTION_COMPUTED = ["etag", "last_modified_time", "status", "in_progress_validation_batches", "trusted_key_groups", "trusted_signers"];
const DISTRIBUTION_NAMES: Readonly<Record<string, string>> = {
  default_cache_behavior: "the default behaviour (the site)",
  ordered_cache_behavior: "the /gs* behaviour (cache / origin-request policy, methods, protocol)",
  aliases: "the aliases",
  viewer_certificate: "the viewer certificate",
  enabled: "enabled",
  web_acl_id: "the WAF",
  restrictions: "the geo restrictions",
  origin_group: "the origin groups",
};

/** The distribution's update, before -> after: null when ONLY gs-alb's domain moved to `to`. */
export function originCutoverProblem(c: PlannedChange, to: string): string | null {
  const { changed, unknown } = changedAttributes(c, DISTRIBUTION_COMPUTED);
  const other = [...unknown.filter((k) => k !== "origin").map((k) => `${k} (unknown)`), ...changed.filter((k) => k !== "origin").map((k) => DISTRIBUTION_NAMES[k] ?? k)];
  if (other.length > 0) return `changes beyond the /gs* origin's domain: ${other.join(", ")}`;
  if (unknown.includes("origin")) return "the origins are unknown until apply";
  const ids = (value: Json) => arr(value).map((o) => String(obj(o).origin_id));
  for (const [when, value] of [["before", c.before.origin], ["after", c.after.origin]] as const) {
    const list = ids(value);
    if (new Set(list).size !== list.length) return `duplicate origin_id ${when} the change (${list.join(",")})`;
  }
  const byId = (value: Json) => new Map(arr(value).map(obj).map((o) => [String(o.origin_id), o] as const));
  const before = byId(c.before.origin);
  const after = byId(c.after.origin);
  if (!same([...before.keys()].sort(), [...after.keys()].sort())) return `the origin set changes (${[...before.keys()].join(",")} -> ${[...after.keys()].join(",")})`;
  if (!before.has("gs-alb")) return "no gs-alb origin (the /gs* origin)";
  for (const [id, b] of before) {
    const a = after.get(id)!;
    if (id !== "gs-alb") {
      if (!same(a, b)) return `the ${id === "site" ? "DEFAULT (site)" : id} origin changes`;
      continue;
    }
    if (!same({ ...a, domain_name: null }, { ...b, domain_name: null })) return "the /gs* origin changes more than its domain name (protocol, TLS, timeouts, headers or path)";
    if (a.domain_name !== to) return `the /gs* origin would point at ${String(a.domain_name)}, not ${to}`;
    if (b.domain_name === to) return `the /gs* origin already points at ${to}`;
  }
  const gs = arr(c.after.ordered_cache_behavior).map(obj).find((o) => o.path_pattern === "/gs*");
  if (gs === undefined || gs.target_origin_id !== "gs-alb") return "the /gs* behaviour does not target gs-alb";
  if (obj(arr(c.after.default_cache_behavior)[0]).target_origin_id !== "site") return "the default behaviour does not target the site";
  return null;
}

function edgeCutoverGate(plan: Json, changes: readonly PlannedChange[], ctx: MigrationContext): Check[] {
  const m = STACK_MODULE.app;
  const checks: Check[] = [];
  const to = ctx.originDomain ?? "";
  checks.push(judge("the target origin is named", /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(to), `--origin-domain ${to}`, "--origin-domain <the host's origin_hostname> (or the ALB's name for the rollback) is required"));
  const dist = addressIs(m, "aws_cloudfront_distribution.site[0]");
  checks.push(
    allowlistCheck(
      changes,
      [
        (c) => {
          if (!dist(c)) return { matched: false };
          if (c.kind !== "update") return { matched: true, problem: `a ${c.kind}: the EXISTING distribution is updated in place, never replaced or destroyed (its domain and aliases are the site)` };
          const p = originCutoverProblem(c, to);
          return p === null ? { matched: true } : { matched: true, problem: p };
        },
      ],
      `only the /gs* origin's domain -> ${to || "(unnamed)"}`,
    ),
  );
  const d = changes.find(dist);
  checks.push(judge("the existing distribution is updated", d?.kind === "update", "aws_cloudfront_distribution.site[0]: update in place", d === undefined ? "the plan does not contain the distribution (is it Terraform-managed here: edge.create_distribution?)" : `the distribution is ${d.kind}`));
  checks.push(ecsUntouchedCheck(plan, changes));
  checks.push(namedForbidden("no table, key, IAM or document authority mutated", changes, (c) => AUTHORITY_TYPES.includes(c.type) || isKms(c) || c.type.startsWith(IAM_PREFIX) || c.type === "aws_ssm_parameter" || c.type === "aws_cloudfront_origin_request_policy", "tables, keys, roles, policies, documents and the /gs* origin-request policy unchanged", "the cutover moves traffic only"));
  const vars: string[] = [];
  if (variable(plan, "compute") !== "ecs") vars.push(`compute = ${JSON.stringify(variable(plan, "compute"))} (the ECS-era resources go at step 20, after the cutover is proven)`);
  if (variable(plan, "recovery_break_glass") !== false) vars.push(`recovery_break_glass = ${JSON.stringify(variable(plan, "recovery_break_glass"))}`);
  checks.push(judge("variables: still compute = ecs, break-glass off", vars.length === 0, "compute = ecs, recovery_break_glass = false", vars.join("; ")));
  return checks;
}

/* ------------------------------------------------------------------ */
/* Gate R: ecs-rollback                                                 */
/* ------------------------------------------------------------------ */

function ecsRollbackGate(plan: Json, changes: readonly PlannedChange[], ctx: MigrationContext): Check[] {
  const m = STACK_MODULE.app;
  const checks: Check[] = [];
  const primary = addressIs(m, `aws_ecs_service.pool["${ctx.pool}"]`);
  checks.push(
    allowlistCheck(
      changes,
      [
        (c) => {
          if (!primary(c)) return { matched: false };
          if (c.kind !== "update") return { matched: true, problem: `a ${c.kind}: the drained service is scaled in place` };
          const p = onlyAttributes(c, ["desired_count"]);
          if (p !== null) return { matched: true, problem: p };
          if (c.before.desired_count !== 0 || c.after.desired_count !== 1) return { matched: true, problem: `desired ${String(c.before.desired_count)} -> ${String(c.after.desired_count)} (0 -> 1 only)` };
          return { matched: true };
        },
      ],
      `only ${ctx.pool}'s service, desired 0 -> 1`,
    ),
  );
  const p1 = changes.find(primary);
  checks.push(judge(`${ctx.pool} restarts`, p1?.kind === "update", `aws_ecs_service.pool["${ctx.pool}"] 0 -> 1 (the host must be stopped --until-deploy FIRST)`, p1 === undefined ? "the primary's service is not in the plan" : `the primary's service is ${p1.kind}`));
  const retired = changes.filter((c) => c.type === "aws_ecs_service" && ctx.retiredPools.some((p) => c.address === `${m}.aws_ecs_service.pool["${p}"]`));
  const awake = retired.filter((c) => c.kind !== "no-op" || Number(c.after.desired_count) !== 0);
  checks.push(judge(`the retired pool(s) stay drained`, awake.length === 0, `${ctx.retiredPools.join(", ")}: desired 0, unchanged`, `${list(awake)} -- only the primary rolls back`));
  const routing = [...priorResources(plan).entries()].find(([a, r]) => r.mode === "data" && /data\.aws_dynamodb_table_item\.routing\[0\]$/.test(a));
  let primaryPool: string | null = null;
  try {
    primaryPool = str(obj(obj(JSON.parse(String(routing?.[1].values.item ?? "null"))).primary_pool).S);
  } catch {
    primaryPool = null;
  }
  const deferred = changes.some((c) => c.mode === "data" && /aws_dynamodb_table_item\.routing/.test(c.address));
  checks.push(judge("SYSTEM/ROUTING read at plan time names the pool", !deferred && primaryPool === ctx.pool && variable(plan, "start_services") === true && variable(plan, "compute") === "ecs", `start_services = true, compute = ecs, routing primary ${String(primaryPool)}`, deferred ? "the routing read is deferred to apply" : `routing primary ${String(primaryPool)}, start_services ${JSON.stringify(variable(plan, "start_services"))}, compute ${JSON.stringify(variable(plan, "compute"))}`));
  return checks;
}

/* ------------------------------------------------------------------ */
/* Gate D: compute-none                                                 */
/* ------------------------------------------------------------------ */

/** The ECS-era classes compute = "none" destroys (modules/app: every resource gated on local.ecs). */
export const TEARDOWN_CLASSES: ReadonlyArray<{ readonly label: string; readonly resources: ReadonlyArray<readonly [string, string]> }> = [
  { label: "ECS services / task definitions / cluster", resources: [["aws_ecs_service", "pool"], ["aws_ecs_task_definition", "pool"], ["aws_ecs_cluster", "this"]] },
  { label: "ALB / listener / rules / target groups", resources: [["aws_lb", "this"], ["aws_lb_listener", "https"], ["aws_lb_listener_rule", "gs"], ["aws_lb_listener_rule", "pool"], ["aws_lb_target_group", "pool"]] },
  {
    label: "ECS / ALB / endpoint security groups and rules",
    resources: [
      ["aws_security_group", "alb"],
      ["aws_security_group", "task"],
      ["aws_security_group", "endpoints"],
      ["aws_vpc_security_group_ingress_rule", "alb_from_cloudfront"],
      ["aws_vpc_security_group_ingress_rule", "task_from_alb"],
      ["aws_vpc_security_group_ingress_rule", "endpoints_from_tasks"],
      ["aws_vpc_security_group_egress_rule", "alb_to_tasks"],
      ["aws_vpc_security_group_egress_rule", "task_https"],
    ],
  },
  { label: "interface / gateway endpoints", resources: [["aws_vpc_endpoint", "gateway"], ["aws_vpc_endpoint", "interface"]] },
  { label: "legacy per-pool log groups", resources: [["aws_cloudwatch_log_group", "pool"]] },
  { label: "legacy alarms / composites / flip suppressors", resources: [["aws_cloudwatch_metric_alarm", "gs"], ["aws_cloudwatch_metric_alarm", "flip_window"], ["aws_cloudwatch_composite_alarm", "notify"]] },
  { label: "ECS task / execution roles", resources: [["aws_iam_role", "task"], ["aws_iam_role", "execution"], ["aws_iam_role_policy", "task"], ["aws_iam_role_policy", "execution"]] },
];

const teardownClassOf = (type: string, name: string): string | null => TEARDOWN_CLASSES.find((k) => k.resources.some(([t, n]) => t === type && n === name))?.label ?? null;

/** p1's runtime document: identical but for the retired pools leaving its route table. null = acceptable. */
export function runtimeDocumentProblem(beforeText: Json, afterText: Json, ctx: MigrationContext): string | null {
  const pb = strictParse(beforeText);
  const pa = strictParse(afterText);
  if (pb === undefined || pa === undefined) return "the runtime document is unknown at plan time, unreadable or ambiguous (a duplicate key)";
  const b = obj(pb);
  const a = obj(pa);
  const { routes: rb, ...restB } = b;
  const { routes: ra, ...restA } = a;
  if (!same(restA, restB)) return "the document changes more than its route table";
  if (a.pool !== ctx.pool || Number(a.generation) !== ctx.servingGeneration || a.game_table !== gameTableName(ctx, ctx.servingGeneration)) return `the document must stay pool ${ctx.pool}, generation ${ctx.servingGeneration}, ${gameTableName(ctx, ctx.servingGeneration)}`;
  const expected = Object.fromEntries(Object.entries(obj(rb)).filter(([pool]) => !ctx.retiredPools.includes(pool)));
  if (!same(ra, expected) || !Object.prototype.hasOwnProperty.call(obj(ra), ctx.pool)) return `the route table must become exactly ${canonical(expected)} (got ${canonical(ra)})`;
  return null;
}

/** An operator / bootstrap / recovery inline policy may only LOSE the retired pools' runtime-document ARNs. null = acceptable. */
export function retiredPoolNarrowingProblem(beforeText: Json, afterText: Json, ctx: MigrationContext): string | null {
  const before = parsePolicy(beforeText);
  const after = parsePolicy(afterText);
  if (before === null || after === null) return "the policy is unknown at plan time or unreadable";
  if (before.version !== after.version || !same([...before.statements.keys()].sort(), [...after.statements.keys()].sort())) return "statements added, removed or re-versioned (only the retired pools' documents may leave)";
  const retired = new Set(ctx.retiredPools.map((p) => `/gs/${ctx.environment}/runtime/${p}`));
  let narrowed = 0;
  for (const [sid, s] of before.statements) {
    const b = s.body;
    const a = after.statements.get(sid)!.body;
    if (same(a, b)) continue;
    const rb = asList(b.Resource);
    const ra = asList(a.Resource);
    const removed = rb.filter((r) => !ra.includes(r));
    const added = ra.filter((r) => !rb.includes(r));
    if (added.length > 0) return `statement ${sid} gains ${added.join(", ")}`;
    if (removed.some((r) => !/^arn:aws:ssm:[a-z0-9-]+:[0-9]{12}:parameter(\/.*)$/.test(r) || !retired.has(r.replace(/^arn:aws:ssm:[a-z0-9-]+:[0-9]{12}:parameter/, "")))) return `statement ${sid} loses more than the retired pools' runtime documents (${removed.join(", ")})`;
    if (!same({ ...a, Resource: null }, { ...b, Resource: null })) return `statement ${sid} changes more than its resources`;
    if (ra.length === 0) return `statement ${sid} would be left with no resource`;
    narrowed += 1;
  }
  return narrowed === 0 ? "the update narrows nothing" : null;
}

function computeNoneGate(plan: Json, changes: readonly PlannedChange[], ctx: MigrationContext): Check[] {
  const m = STACK_MODULE.app;
  const checks: Check[] = [];
  const local = (c: PlannedChange) => c.address.slice(m.length + 1);
  const retiredDoc = (c: PlannedChange) => c.type === "aws_ssm_parameter" && c.name === "runtime" && ctx.retiredPools.some((p) => local(c) === `aws_ssm_parameter.runtime["${p}"]`);
  const narrowingPolicy = (c: PlannedChange) => c.type === "aws_iam_role_policy" && ["aws_iam_role_policy.bootstrap", "aws_iam_role_policy.operator[0]", "aws_iam_role_policy.recovery[0]"].includes(local(c));

  checks.push(
    allowlistCheck(
      changes,
      [
        (c) => {
          const cls = teardownClassOf(c.type, c.name);
          if (cls === null || !c.address.startsWith(`${m}.`)) return { matched: false };
          return c.kind === "delete" ? { matched: true } : { matched: true, problem: `${cls}: only DESTROYED here (a ${c.kind}${c.kind === "forget" ? " leaves it running and billed" : ""})` };
        },
        (c) => {
          if (!retiredDoc(c)) return { matched: false };
          return c.kind === "delete" ? { matched: true } : { matched: true, problem: `the retired pool's runtime document is ${c.kind}d, not destroyed` };
        },
        (c) => {
          if (!(c.address === `${m}.aws_ssm_parameter.runtime["${ctx.pool}"]`)) return { matched: false };
          if (c.kind !== "update") return { matched: true, problem: `the ${ctx.pool} runtime document is ${c.kind === "delete" || c.kind === "replace" ? "DESTROYED / REPLACED -- absolutely forbidden" : c.kind}` };
          const attrs = onlyAttributes(c, ["insecure_value"], ["version", "value", "has_value_wo"]);
          if (attrs !== null) return { matched: true, problem: attrs };
          const p = runtimeDocumentProblem(c.before.insecure_value, c.after.insecure_value, ctx);
          return p === null ? { matched: true } : { matched: true, problem: p };
        },
        (c) => {
          if (!narrowingPolicy(c)) return { matched: false };
          if (c.kind !== "update") return { matched: true, problem: `operator / bootstrap authority ${c.kind === "delete" || c.kind === "replace" ? "DESTROYED / REPLACED -- absolutely forbidden" : c.kind}` };
          const attrs = onlyAttributes(c, ["policy"]);
          if (attrs !== null) return { matched: true, problem: attrs };
          const p = retiredPoolNarrowingProblem(c.before.policy, c.after.policy, ctx);
          return p === null ? { matched: true } : { matched: true, problem: p };
        },
      ],
      "the ECS-era classes destroyed; the p1 document and the operator policies narrowed to p1",
    ),
  );

  /* Exactness: every ECS-era object the PRIOR state holds is destroyed; the core classes exist and go. */
  const prior = priorResources(plan);
  const byAddress = new Map(changes.map((c) => [c.address, c] as const));
  if (!hasPriorState(plan)) {
    checks.push(fail("every ECS-era object in the state is destroyed", "the plan carries no prior_state: the guard cannot prove the teardown is complete (capture it with plan-evidence against the real state)"));
  } else {
    const leftovers: string[] = [];
    const destroyedByClass = new Map<string, number>();
    for (const [address, r] of prior) {
      if (r.mode !== "managed" || !address.startsWith(`${m}.`)) continue;
      const cls = teardownClassOf(r.type, r.name) ?? (ctx.retiredPools.some((p) => address === `${m}.aws_ssm_parameter.runtime["${p}"]`) ? "the retired pools' runtime documents" : null);
      if (cls === null) continue;
      const c = byAddress.get(address);
      if (c?.kind !== "delete") leftovers.push(`${address} (${c === undefined ? "not in the plan" : c.kind})`);
      else destroyedByClass.set(cls, (destroyedByClass.get(cls) ?? 0) + 1);
    }
    checks.push(judge("every ECS-era object in the state is destroyed", leftovers.length === 0, [...destroyedByClass.entries()].map(([k, n]) => `${k}: ${n}`).join("; "), `left behind (still billed, or still a second way to serve): ${leftovers.slice(0, 8).join("; ")}${leftovers.length > 8 ? ` ... (${leftovers.length})` : ""}`));
    const core = [
      "aws_ecs_cluster.this[0]",
      "aws_lb.this[0]",
      "aws_lb_listener.https[0]",
      "aws_security_group.alb[0]",
      "aws_security_group.task[0]",
      "aws_iam_role.task[0]",
      ...[ctx.pool, ...ctx.retiredPools].flatMap((p) => [`aws_ecs_service.pool["${p}"]`, `aws_lb_target_group.pool["${p}"]`, `aws_cloudwatch_log_group.pool["${p}"]`]),
      ...ctx.retiredPools.map((p) => `aws_ssm_parameter.runtime["${p}"]`),
    ];
    const coreMissing = core.filter((a) => byAddress.get(`${m}.${a}`)?.kind !== "delete");
    const alarms = changes.filter((c) => c.kind === "delete" && (c.type === "aws_cloudwatch_metric_alarm" || c.type === "aws_cloudwatch_composite_alarm"));
    checks.push(
      judge(
        "the expected destruction classes are all present",
        coreMissing.length === 0 && alarms.length > 0,
        `cluster, ALB + listener, ALB / task SGs, the task role, ${[ctx.pool, ...ctx.retiredPools].join(" / ")} services, target groups and log groups, ${ctx.retiredPools.join(", ")}'s runtime document, ${alarms.length} legacy alarms`,
        `${coreMissing.length > 0 ? `not destroyed: ${coreMissing.join(", ")}` : ""}${alarms.length === 0 ? `${coreMissing.length > 0 ? "; " : ""}no legacy alarm destroyed` : ""} -- this is not the accepted post-abandonment state's teardown`,
      ),
    );
  }

  const authority = (c: PlannedChange): boolean => {
    const l = local(c);
    return (
      c.type === "aws_dynamodb_table" ||
      c.type === "aws_dynamodb_table_item" ||
      isKms(c) ||
      l === `aws_ssm_parameter.runtime["${ctx.pool}"]` ||
      l.startsWith("aws_ssm_parameter.juno_backend") ||
      c.type.startsWith("aws_ecr_") ||
      c.type.startsWith("aws_cloudfront_") ||
      ["aws_iam_role.bootstrap", "aws_iam_role_policy.bootstrap", "aws_iam_role.operator[0]", "aws_iam_role_policy.operator[0]"].includes(l)
    );
  };
  checks.push(
    namedForbidden(
      "ABSOLUTELY FORBIDDEN: no authority destroyed or replaced",
      changes,
      (c) => authority(c) && (c.kind === "delete" || c.kind === "replace" || c.kind === "forget"),
      `g${ctx.servingGeneration}, identity, the ${ctx.pool} and Juno documents, ECR, the distribution, the bootstrap / operator roles kept (and no KMS key in this stack)`,
      "the money state and the authority needed after the migration",
    ),
  );
  checks.push(namedForbidden("the serving tables and the edge: untouched", changes, (c) => c.type === "aws_dynamodb_table" || c.type.startsWith("aws_cloudfront_") || c.type.startsWith("aws_ecr_") || c.type === "aws_dynamodb_table_item", "game / identity tables, the distribution, its policy and ECR: no-op", "the cutover (step 14) is already done and proven; nothing here edits a table"));
  const created = changes.filter((c) => mutating(c) && (c.kind === "create" || c.kind === "replace"));
  checks.push(judge("nothing created", created.length === 0, "a teardown creates nothing", `${list(created)} -- a re-created recovery role, alarm or service is not part of the teardown`));
  const ecsAlive = changes.filter((c) => mutating(c) && ECS_TYPES.includes(c.type) && c.kind !== "delete");
  checks.push(judge("ECS: destroyed, never restarted", ecsAlive.length === 0, "every ECS change is a destroy (no desired-count drift corrected)", `${list(ecsAlive)}`));

  /* The plan-time gates compute = "none" moved onto the documents (modules/app ssm.tf). */
  const priorData = [...prior.entries()].filter(([, r]) => r.mode === "data");
  const read = (re: RegExp): Obj | null => {
    const hit = priorData.find(([a]) => re.test(a));
    if (hit === undefined) return null;
    try {
      return obj(JSON.parse(String(hit[1].values.item)));
    } catch {
      return null;
    }
  };
  const routing = read(/data\.aws_dynamodb_table_item\.routing\[0\]$/);
  const marker = read(/data\.aws_dynamodb_table_item\.generation\[0\]$/);
  const deferred = changes.filter((c) => c.mode === "data" && /aws_dynamodb_table_item\.(routing|generation)/.test(c.address));
  const routingOk = routing !== null && str(obj(routing.fmt).N) === "1" && str(obj(routing.primary_pool).S) === ctx.pool;
  const markerOk = marker !== null && str(obj(marker.generation).N) === String(ctx.servingGeneration) && str(obj(marker.game_table).S) === gameTableName(ctx, ctx.servingGeneration) && str(obj(marker.origin).S) === "bootstrap";
  checks.push(
    judge(
      "the plan-time gates read SYSTEM/ROUTING and SYSTEM/GENERATION",
      deferred.length === 0 && routingOk && markerOk,
      `routing names ${ctx.pool}; ${gameTableName(ctx, ctx.servingGeneration)}'s marker: generation ${ctx.servingGeneration}, bootstrap (never adopted)`,
      deferred.length > 0 ? "a gate read is deferred to apply: the plan could not evaluate it" : !routingOk ? `SYSTEM/ROUTING ${routing === null ? "not read (start_services must be true)" : `format ${String(obj(routing.fmt).N)}, primary ${String(obj(routing.primary_pool).S)}`}` : `SYSTEM/GENERATION ${marker === null ? "not read" : `generation ${String(obj(marker.generation).N)}, ${String(obj(marker.game_table).S)}, ${String(obj(marker.origin).S)}`}`,
    ),
  );
  const vars: string[] = [];
  if (variable(plan, "compute") !== "none") vars.push(`compute = ${JSON.stringify(variable(plan, "compute"))}`);
  if (variable(plan, "start_services") !== true) vars.push(`start_services = ${JSON.stringify(variable(plan, "start_services"))} (true is REQUIRED: it turns the plan-time gates on)`);
  const pools = obj(variable(plan, "pools"));
  if (!same(Object.keys(pools), [ctx.pool]) || obj(pools[ctx.pool]).primary !== true) vars.push(`pools = ${canonical(variable(plan, "pools"))} (exactly { ${ctx.pool} = { primary = true } }${typeof variable(plan, "pools") === "string" ? "; give it in a tfvars file" : ""})`);
  if (variable(plan, "recovery_break_glass") !== false) vars.push(`recovery_break_glass = ${JSON.stringify(variable(plan, "recovery_break_glass"))}`);
  checks.push(judge("variables: compute none, start_services, one pool, break-glass off", vars.length === 0, `compute = none, start_services = true, pools = { ${ctx.pool} }, recovery_break_glass = false`, vars.join("; ")));
  return checks;
}

/* ------------------------------------------------------------------ */
/* Gate F: ecr-lifecycle                                                */
/* ------------------------------------------------------------------ */

/** The lifecycle policy: EXACTLY modules/single-host/ecr.tf's two rules, keeping `keep` (>= minKeep) images. null = acceptable. */
export function ecrLifecycleProblem(policyText: Json, minKeep: number, keep: Json): string | null {
  const parsed = strictParse(policyText);
  if (parsed === undefined) return "the lifecycle policy is unknown at plan time, unreadable or ambiguous (a duplicate key)";
  if (typeof keep !== "number" || !Number.isInteger(keep)) return `ecr_keep_images = ${JSON.stringify(keep)} (a whole number)`;
  if (keep < minKeep) return `keeps only ${keep} images (>= ${minKeep})`;
  const expected = {
    rules: [
      { rulePriority: 1, description: "Untagged layers/manifests (failed or superseded pushes) after 7 days", selection: { tagStatus: "untagged", countType: "sinceImagePushed", countUnit: "days", countNumber: 7 }, action: { type: "expire" } },
      { rulePriority: 2, description: `Keep the newest ${keep} images (rollback history)`, selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: keep }, action: { type: "expire" } },
    ],
  };
  if (same(parsed, expected)) return null;
  /* Say why, in terms of what a rule would expire. */
  for (const r of arr(obj(parsed).rules).map(obj)) {
    const sel = obj(r.selection);
    if (sel.tagStatus !== "untagged" && sel.countType !== "imageCountMoreThan") return `rule ${String(r.rulePriority)}: a ${String(sel.tagStatus)} rule by ${String(sel.countType)} (an age rule could expire the running release)`;
    if (sel.tagStatus !== "untagged" && !(Number.isInteger(sel.countNumber) && Number(sel.countNumber) >= minKeep)) return `rule ${String(r.rulePriority)}: keeps only ${String(sel.countNumber)} images (>= ${minKeep})`;
  }
  return "the policy is not exactly the module's two rules (untagged after 7 days; keep the newest ecr_keep_images)";
}

function ecrLifecycleGate(plan: Json, changes: readonly PlannedChange[], ctx: MigrationContext): Check[] {
  const m = STACK_MODULE["single-host"];
  const minKeep = ctx.minEcrKeepImages ?? STAGING_DEFAULTS.minEcrKeepImages;
  const checks: Check[] = [];
  const target = addressIs(m, "aws_ecr_lifecycle_policy.server[0]");
  checks.push(
    allowlistCheck(
      changes,
      [
        (c) => {
          if (!target(c)) return { matched: false };
          if (c.kind !== "create") return { matched: true, problem: `a ${c.kind}` };
          if (c.after.repository !== `gs-${ctx.environment}-server`) return { matched: true, problem: `on repository ${String(c.after.repository)}` };
          const keepVar = variable(plan, "ecr_keep_images");
          const p = ecrLifecycleProblem(c.after.policy, minKeep, typeof keepVar === "string" && /^[0-9]+$/.test(keepVar) ? Number(keepVar) : keepVar);
          return p === null ? { matched: true } : { matched: true, problem: p };
        },
      ],
      `only the lifecycle policy on gs-${ctx.environment}-server`,
    ),
  );
  checks.push(judge("the lifecycle policy is created", changes.find(target)?.kind === "create", "aws_ecr_lifecycle_policy.server[0]: create", "the plan does not create it"));
  checks.push(judge("variables: manage_ecr_lifecycle", variable(plan, "manage_ecr_lifecycle") === true, "manage_ecr_lifecycle = true", `manage_ecr_lifecycle = ${JSON.stringify(variable(plan, "manage_ecr_lifecycle"))}`));
  return checks;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

const summarize = (changes: readonly PlannedChange[]): Record<string, number> => {
  const count: Record<string, number> = {};
  for (const c of changes) count[c.kind] = (count[c.kind] ?? 0) + 1;
  return count;
};

/** Judge one saved plan (`terraform show -json`) for one migration step. */
export function judgeMigrationPlan(gate: GateName, plan: Json, ctx: MigrationContext): GuardResult {
  const changes = changesOf(plan);
  const checks: Check[] = [...commonChecks(gate, plan, changes, ctx)];
  switch (gate) {
    case "ledger-host-authorize":
    case "ledger-task-deauthorize":
      checks.push(...ledgerPrincipalGate(gate, plan, changes, ctx));
      break;
    case "host-create":
      checks.push(...hostCreateGate(plan, changes, ctx));
      break;
    case "edge-cutover":
      checks.push(...edgeCutoverGate(plan, changes, ctx));
      break;
    case "ecs-rollback":
      checks.push(...ecsRollbackGate(plan, changes, ctx));
      break;
    case "compute-none":
      checks.push(...computeNoneGate(plan, changes, ctx));
      break;
    case "ecr-lifecycle":
      checks.push(...ecrLifecycleGate(plan, changes, ctx));
      break;
  }
  return {
    format: MIGRATION_GUARD_FORMAT,
    gate,
    stack: GATES[gate].stack,
    verdict: checks.every((c) => c.status === "pass") ? "PASS" : "FAIL",
    checks,
    summary: { actions: summarize(changes), changes: changes.filter(mutating).map(label) },
  };
}
