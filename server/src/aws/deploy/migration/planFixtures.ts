// server/src/aws/deploy/migration/planFixtures.ts
//
// COST-2B: the SYNTHETIC saved plans (`terraform show -json` shape: format 1.2, resource_changes with before / after /
// after_unknown, prior_state, resource_drift, variables) of every guarded migration step, starting from the ACCEPTED
// POST-ABANDONMENT staging state: APPGEN 1, g1 serving, g2 unadopted and OUTSIDE Terraform, both pools drained 0/0/0
// (the state remembers desired 1), the recovery role removed, break-glass off. Addresses, names and policy statements
// follow modules/{ledger,app,single-host} exactly; account ids, ARNs and names are test values (no real account).
//
// TEST SUPPORT ONLY -- never imported by the application or the tools. The committed copies are
// infra/aws/fixtures/migration-plans/<gate>.json; `cost2bMigrationGuards.test.ts` proves they equal this builder's output
// (regenerate: `node dist/server/src/aws/deploy/migration/planFixtures.js --write` after `npm run build`).

import * as fs from "fs";
import * as path from "path";

import type { GateName } from "./planGuards";

type Obj = Record<string, unknown>;

export const FIXTURE = Object.freeze({
  environment: "staging",
  appAccountId: "111111111111",
  ledgerAccountId: "222222222222",
  region: "us-east-1",
  ledgerTableArn: "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger",
  signingKeyArns: Object.freeze(["arn:aws:kms:us-east-1:222222222222:key/11111111-1111-4111-8111-111111111111", "arn:aws:kms:us-east-1:222222222222:key/22222222-2222-4222-8222-222222222222", "arn:aws:kms:us-east-1:222222222222:key/33333333-3333-4333-8333-333333333333"]),
  hostOrigin: "gs-origin-host.example.org",
  albOrigin: "gs-origin-alb.example.org",
});
const E = FIXTURE.environment;
const APP = FIXTURE.appAccountId;
const LEDGER = FIXTURE.ledgerAccountId;
const R = FIXTURE.region;
const role = (name: string) => `arn:aws:iam::${APP}:role/gs-${E}-${name}`;
export const TASK_ROLE = role("app-task");
export const HOST_ROLE = role("host-app");
const BOOT_ROLE = role("bootstrap");
const OPER_ROLE = role("operator");
const RECOVERY_ROLE = role("recovery");
const APP_ROOT = `arn:aws:iam::${APP}:root`;
const LEDGER_ROOT = `arn:aws:iam::${LEDGER}:root`;
const LEDGER_ARN = `arn:aws:dynamodb:${R}:${LEDGER}:table/gs-${E}-ledger`;
const KEYS: Readonly<Record<string, string>> = {
  admission: `arn:aws:kms:${R}:${LEDGER}:key/33333333-3333-4333-8333-333333333333`,
  relayer: `arn:aws:kms:${R}:${LEDGER}:key/11111111-1111-4111-8111-111111111111`,
  settlement: `arn:aws:kms:${R}:${LEDGER}:key/22222222-2222-4222-8222-222222222222`,
};
const table = (name: string) => `arn:aws:dynamodb:${R}:${APP}:table/${name}`;
const G1 = `gs-${E}-game-g1`;
const IDENTITY = `gs-${E}-identity`;
const param = (name: string) => `arn:aws:ssm:${R}:${APP}:parameter${name}`;
const RUNTIME = (pool: string) => param(`/gs/${E}/runtime/${pool}`);
const JUNO = param(`/gs/${E}/juno-backend`);
const PROVIDER = "registry.terraform.io/hashicorp/aws";
const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6";

/* ------------------------------------------------------------------ */
/* JSON helpers                                                         */
/* ------------------------------------------------------------------ */

/** Terraform's jsonencode: object keys sorted. */
export function jsonencode(value: unknown): string {
  const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : typeof v === "object" && v !== null ? Object.fromEntries(Object.keys(v as Obj).sort().map((k) => [k, sort((v as Obj)[k])])) : v);
  return JSON.stringify(sort(value));
}

/** aws_iam_policy_document's rendering: a one-element list is written as a bare string. */
export function policyDocument(statements: readonly Obj[]): string {
  const one = (v: unknown): unknown => (Array.isArray(v) && v.length === 1 ? v[0] : v);
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: statements.map((s) => {
      const out: Obj = { Sid: s.Sid, Effect: s.Effect ?? "Allow", Action: one(s.Action), Resource: one(s.Resource) };
      if (s.Principal !== undefined) out.Principal = Object.fromEntries(Object.entries(s.Principal as Obj).map(([k, v]) => [k, one(v)]));
      if (s.Condition !== undefined) out.Condition = Object.fromEntries(Object.entries(s.Condition as Obj).map(([op, b]) => [op, Object.fromEntries(Object.entries(b as Obj).map(([k, v]) => [k, one(v)]))]));
      return out;
    }),
  });
}

const indexSuffix = (index: unknown): string => (index === undefined ? "" : typeof index === "number" ? `[${index}]` : `[${JSON.stringify(index)}]`);

export interface Rc {
  readonly module: string;
  readonly type: string;
  readonly name: string;
  readonly index?: string | number;
  readonly actions: readonly string[];
  readonly before: Obj | null;
  readonly after: Obj | null;
  readonly afterUnknown?: Obj;
  readonly mode?: "managed" | "data";
  readonly reason?: string;
}

export function resourceChange(rc: Rc): Obj {
  const address = `${rc.module}.${rc.mode === "data" ? "data." : ""}${rc.type}.${rc.name}${indexSuffix(rc.index)}`;
  const out: Obj = {
    address,
    module_address: rc.module,
    mode: rc.mode ?? "managed",
    type: rc.type,
    name: rc.name,
    ...(rc.index === undefined ? {} : { index: rc.index }),
    provider_name: PROVIDER,
    change: { actions: [...rc.actions], before: rc.before, after: rc.after, after_unknown: rc.afterUnknown ?? {}, before_sensitive: rc.before === null ? false : {}, after_sensitive: rc.after === null ? false : {} },
  };
  if (rc.reason !== undefined) out.action_reason = rc.reason;
  return out;
}

const noop = (module: string, type: string, name: string, values: Obj, index?: string | number): Rc => ({ module, type, name, index, actions: ["no-op"], before: values, after: values });

function priorState(module: string, rcs: readonly Rc[], data: readonly Rc[] = []): Obj {
  const resources = [...rcs.filter((r) => r.before !== null), ...data].map((r) => ({
    address: `${module}.${r.mode === "data" ? "data." : ""}${r.type}.${r.name}${indexSuffix(r.index)}`,
    mode: r.mode ?? "managed",
    type: r.type,
    name: r.name,
    ...(r.index === undefined ? {} : { index: r.index }),
    provider_name: PROVIDER,
    schema_version: 0,
    values: r.before,
  }));
  return { format_version: "1.0", terraform_version: "1.9.8", values: { root_module: { child_modules: [{ address: module, resources }] } } };
}

const DATA_SOURCES: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  "module.ledger": [["aws_partition", "current"], ["aws_caller_identity", "current"], ["aws_region", "current"], ["aws_iam_policy_document", "ledger_resource"], ["aws_iam_policy_document", "signing"], ["aws_iam_policy_document", "vault_access"], ["aws_iam_policy_document", "backup_assume"]],
  "module.host": [["aws_partition", "current"], ["aws_caller_identity", "current"], ["aws_region", "current"], ["aws_ec2_managed_prefix_list", "cloudfront_origin_facing"]],
  "module.app": [["aws_partition", "current"], ["aws_caller_identity", "current"], ["aws_region", "current"], ["aws_ec2_managed_prefix_list", "cloudfront_origin_facing"], ["aws_iam_policy_document", "bootstrap"], ["aws_iam_policy_document", "operator"], ["aws_dynamodb_table_item", "routing"], ["aws_dynamodb_table_item", "generation"]],
};
const MODULE_SOURCES: Readonly<Record<string, string>> = { "module.ledger": "../../modules/ledger", "module.host": "../../modules/single-host", "module.app": "../../modules/app" };

/** `configuration` as Terraform writes it: the root's ONE module call and that module's resource declarations. */
function configuration(module: string, rcs: readonly Rc[]): Obj {
  const managed = [...new Map(rcs.filter((r) => (r.mode ?? "managed") === "managed").map((r) => [`${r.type}.${r.name}`, r] as const)).values()];
  const resources = [
    ...managed.map((r) => ({ address: `${r.type}.${r.name}`, mode: "managed", type: r.type, name: r.name, provider_config_key: "aws", expressions: {}, schema_version: 0 })),
    ...DATA_SOURCES[module].map(([type, name]) => ({ address: `data.${type}.${name}`, mode: "data", type, name, provider_config_key: "aws", expressions: {}, schema_version: 0 })),
  ];
  return {
    provider_config: { aws: { name: "aws", full_name: PROVIDER, version_constraint: "6.66.0" } },
    root_module: { module_calls: { [module.slice("module.".length)]: { source: MODULE_SOURCES[module], expressions: {}, module: { resources } } } },
  };
}

function planEnvelope(variables: Obj, rcs: readonly Rc[], prior: Obj | null, drift: readonly Obj[] = []): Obj {
  return {
    format_version: "1.2",
    terraform_version: "1.9.8",
    variables: Object.fromEntries(Object.entries(variables).map(([k, v]) => [k, { value: v }])),
    planned_values: { root_module: {} },
    ...(drift.length === 0 ? {} : { resource_drift: drift }),
    resource_changes: rcs.map(resourceChange),
    ...(prior === null ? {} : { prior_state: prior }),
    configuration: configuration(String(rcs[0]?.module ?? "module.app"), rcs),
    timestamp: "2026-10-02T20:00:00Z",
    applyable: true,
    complete: true,
    errored: false,
  };
}

/* ------------------------------------------------------------------ */
/* The ledger stack                                                     */
/* ------------------------------------------------------------------ */

const condArn = (values: readonly string[]) => ({ ArnEquals: { "aws:PrincipalArn": [...values] } });
const app = { AWS: [APP_ROOT] };

export function ledgerResourcePolicy(runtime: readonly string[]): string {
  return policyDocument([
    { Sid: "AppTaskLedgerRead", Action: ["dynamodb:ConditionCheckItem", "dynamodb:GetItem", "dynamodb:Query"], Resource: [LEDGER_ARN], Principal: app, Condition: condArn(runtime) },
    { Sid: "AppTaskLedgerPutNeverAppgen", Action: ["dynamodb:PutItem"], Resource: [LEDGER_ARN], Principal: app, Condition: { ...condArn(runtime), "ForAllValues:StringNotEquals": { "dynamodb:LeadingKeys": ["APPGEN", "APPGEN#HISTORY"] } } },
    { Sid: "BootstrapAppgenOnly", Action: ["dynamodb:GetItem", "dynamodb:PutItem"], Resource: [LEDGER_ARN], Principal: app, Condition: { ...condArn([BOOT_ROLE]), "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["APPGEN"] } } },
    { Sid: "BootstrapAppgenHistoryRead", Action: ["dynamodb:GetItem"], Resource: [LEDGER_ARN], Principal: app, Condition: { ...condArn([BOOT_ROLE]), "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["APPGEN#HISTORY"] } } },
    { Sid: "OperatorLedgerReadOnly", Action: ["dynamodb:GetItem", "dynamodb:Scan"], Resource: [LEDGER_ARN], Principal: app, Condition: condArn([OPER_ROLE]) },
    { Sid: "RecoveryLedgerRead", Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"], Resource: [LEDGER_ARN], Principal: app, Condition: condArn([RECOVERY_ROLE]) },
    { Sid: "RecoveryAppgenAdoption", Action: ["dynamodb:UpdateItem"], Resource: [LEDGER_ARN], Principal: app, Condition: { ...condArn([RECOVERY_ROLE]), "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["APPGEN"] } } },
    { Sid: "RecoveryAppgenHistoryAppend", Action: ["dynamodb:PutItem"], Resource: [LEDGER_ARN], Principal: app, Condition: { ...condArn([RECOVERY_ROLE]), "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["APPGEN#HISTORY"] } } },
    { Sid: "BootstrapDescribe", Action: ["dynamodb:DescribeTable"], Resource: [LEDGER_ARN], Principal: app, Condition: condArn([BOOT_ROLE]) },
  ]);
}

export function signingKeyPolicy(runtime: readonly string[]): string {
  return policyDocument([
    {
      Sid: "KeyAdministrationWithoutSigning",
      Action: ["kms:CancelKeyDeletion", "kms:Describe*", "kms:DisableKey", "kms:EnableKey", "kms:Get*", "kms:List*", "kms:PutKeyPolicy", "kms:RetireGrant", "kms:RevokeGrant", "kms:ScheduleKeyDeletion", "kms:TagResource", "kms:UntagResource", "kms:UpdateKeyDescription"],
      Resource: ["*"],
      Principal: { AWS: [LEDGER_ROOT] },
    },
    { Sid: "AppTaskPublicKey", Action: ["kms:GetPublicKey"], Resource: ["*"], Principal: app, Condition: condArn(runtime) },
    { Sid: "AppTaskSignDigestOnly", Action: ["kms:Sign"], Resource: ["*"], Principal: app, Condition: { ...condArn(runtime), StringEquals: { "kms:MessageType": ["DIGEST"], "kms:SigningAlgorithm": ["ECDSA_SHA_256"] } } },
    { Sid: "BootstrapVerifyReadOnly", Action: ["kms:DescribeKey", "kms:GetPublicKey", "kms:ListGrants"], Resource: ["*"], Principal: app, Condition: condArn([BOOT_ROLE]) },
  ]);
}

const LM = "module.ledger";
const ledgerTags = { "gs:component": "ledger", "gs:environment": E, "gs:slice": "live5-l5-8" };
const tagsAll = (tags: Obj, stack: string) => ({ ...tags, "gs:managed-by": "terraform", "gs:stack": stack, "gs:environment": E });

function ledgerStatic(): Rc[] {
  return [
    noop(LM, "aws_dynamodb_table", "ledger", { name: `gs-${E}-ledger`, arn: LEDGER_ARN, billing_mode: "PAY_PER_REQUEST", hash_key: "pk", range_key: "sk", deletion_protection_enabled: true, point_in_time_recovery: [{ enabled: true, recovery_period_in_days: 35 }], stream_enabled: false, replica: [], ttl: [{ enabled: false, attribute_name: "" }], tags: { ...ledgerTags, Name: `gs-${E}-ledger` }, tags_all: tagsAll({ ...ledgerTags, Name: `gs-${E}-ledger` }, "ledger") }),
    noop(LM, "aws_backup_vault", "ledger", { name: `gs-${E}-ledger`, force_destroy: false, kms_key_arn: `arn:aws:kms:${R}:${LEDGER}:key/aws-backup-default`, tags: ledgerTags, tags_all: tagsAll(ledgerTags, "ledger") }),
    noop(LM, "aws_backup_vault_lock_configuration", "ledger", { backup_vault_name: `gs-${E}-ledger`, min_retention_days: 35, max_retention_days: 3650, changeable_for_days: null }),
    noop(LM, "aws_backup_vault_policy", "ledger", { backup_vault_name: `gs-${E}-ledger`, policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: "NoEarlyDeletionOrShortening", Effect: "Deny", Action: ["backup:DeleteRecoveryPoint", "backup:UpdateRecoveryPointLifecycle"], Resource: "*", Principal: { AWS: "*" } }] }) }),
    noop(LM, "aws_iam_role", "backup", { name: `gs-${E}-ledger-backup`, arn: `arn:aws:iam::${LEDGER}:role/gs-${E}-ledger-backup` }),
    noop(LM, "aws_iam_role_policy_attachment", "backup", { role: `gs-${E}-ledger-backup`, policy_arn: "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup" }),
    noop(LM, "aws_backup_plan", "ledger", { name: `gs-${E}-ledger`, rule: [{ rule_name: "daily", target_vault_name: `gs-${E}-ledger`, schedule: "cron(17 3 * * ? *)", lifecycle: [{ delete_after: 35 }] }] }),
    noop(LM, "aws_backup_selection", "ledger", { name: `gs-${E}-ledger`, resources: [LEDGER_ARN] }),
  ];
}

const kmsValues = (purpose: string, policy: string): Obj => {
  const tags = { ...ledgerTags, Name: `gs-${E}-${purpose}`, "gs:signing-purpose": purpose };
  return {
    arn: KEYS[purpose],
    key_id: KEYS[purpose].split("/")[1],
    id: KEYS[purpose].split("/")[1],
    description: `18Cosmos ${E} ${purpose} signing key (secp256k1, digest only; named by key ARN, never an alias)`,
    customer_master_key_spec: "ECC_SECG_P256K1",
    key_usage: "SIGN_VERIFY",
    multi_region: false,
    is_enabled: true,
    enable_key_rotation: false,
    deletion_window_in_days: 30,
    bypass_policy_lockout_safety_check: false,
    custom_key_store_id: "",
    rotation_period_in_days: 0,
    xks_key_id: "",
    region: R,
    policy,
    tags,
    tags_all: tagsAll(tags, "ledger"),
  };
};

function ledgerPlan(before: readonly string[], after: readonly string[], taskAuthorized: boolean): Obj {
  const rp = (runtime: readonly string[], revision: string | null): Obj => ({ id: LEDGER_ARN, resource_arn: LEDGER_ARN, policy: ledgerResourcePolicy(runtime), revision_id: revision, confirm_remove_self_resource_access: false, region: R });
  const rcs: Rc[] = [
    ...ledgerStatic(),
    { module: LM, type: "aws_dynamodb_resource_policy", name: "ledger", actions: ["update"], before: rp(before, "1727900000000"), after: rp(after, null), afterUnknown: { revision_id: true } },
    ...Object.keys(KEYS).map((purpose): Rc => ({ module: LM, type: "aws_kms_key", name: "signing", index: purpose, actions: ["update"], before: kmsValues(purpose, signingKeyPolicy(before)), after: kmsValues(purpose, signingKeyPolicy(after)) })),
  ];
  return planEnvelope(
    { region: R, ledger_account_id: LEDGER, environment: E, app_account_id: APP, backup: {}, signing_keys_enabled: true, relayer_key_count: 1, tags: {}, app_runtime_role_arns: [HOST_ROLE], ecs_task_role_authorized: taskAuthorized },
    rcs,
    priorState(LM, rcs),
  );
}

/* ------------------------------------------------------------------ */
/* The single-host stack                                                */
/* ------------------------------------------------------------------ */

const HM = "module.host";
const hostTags = { "gs:component": "single-host", "gs:environment": E, "gs:slice": "cost-1" };

export function hostPolicy(gameTables: readonly string[] = [G1]): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Sid: "GameTableReadAndCheck", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:ConditionCheckItem"], Resource: gameTables.map(table) },
      { Sid: "GameTableWriteNeverSystem", Effect: "Allow", Action: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"], Resource: gameTables.map(table), Condition: { "ForAllValues:StringNotEquals": { "dynamodb:LeadingKeys": ["SYSTEM"] } } },
      { Sid: "IdentityTable", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Scan", "dynamodb:ConditionCheckItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"], Resource: [table(IDENTITY)] },
      { Sid: "LedgerReadAndCheck", Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"], Resource: [LEDGER_ARN] },
      { Sid: "LedgerAppendNeverAppgen", Effect: "Allow", Action: ["dynamodb:PutItem"], Resource: [LEDGER_ARN], Condition: { "ForAllValues:StringNotEquals": { "dynamodb:LeadingKeys": ["APPGEN", "APPGEN#HISTORY"] } } },
      { Sid: "ReadRuntimeConfiguration", Effect: "Allow", Action: ["ssm:GetParameter"], Resource: [RUNTIME("p1"), JUNO] },
      { Sid: "SigningKeysPublicKey", Effect: "Allow", Action: ["kms:GetPublicKey"], Resource: [KEYS.relayer, KEYS.settlement, KEYS.admission] },
      { Sid: "SigningKeysSignDigestOnly", Effect: "Allow", Action: ["kms:Sign"], Resource: [KEYS.relayer, KEYS.settlement, KEYS.admission], Condition: { StringEquals: { "kms:SigningAlgorithm": "ECDSA_SHA_256", "kms:MessageType": "DIGEST" } } },
      { Sid: "EcrAuthTokenUnscopable", Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: ["*"] },
      { Sid: "PullThisRepositoryOnly", Effect: "Allow", Action: ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], Resource: [`arn:aws:ecr:${R}:${APP}:repository/gs-${E}-server`] },
      { Sid: "WriteThisHostLogsOnly", Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: [`arn:aws:logs:${R}:${APP}:log-group:/gs/${E}/host:log-stream:*`] },
      { Sid: "HostPressureMetricOnly", Effect: "Allow", Action: ["cloudwatch:PutMetricData"], Resource: ["*"], Condition: { StringEquals: { "cloudwatch:namespace": "18Cosmos/Host" } } },
      { Sid: "SsmAgentRegister", Effect: "Allow", Action: ["ssm:UpdateInstanceInformation", "ssm:ListInstanceAssociations"], Resource: [`arn:aws:ec2:${R}:${APP}:instance/*`] },
      {
        Sid: "SsmAgentChannelsUnscopable",
        Effect: "Allow",
        Action: ["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel", "ec2messages:AcknowledgeMessage", "ec2messages:DeleteMessage", "ec2messages:FailMessage", "ec2messages:GetEndpoint", "ec2messages:GetMessages", "ec2messages:SendReply"],
        Resource: ["*"],
      },
    ],
  });
}

const alarm = (name: string, metric: string, namespace: string): Obj => ({ alarm_name: `gs-${E}-host-${name}`, metric_name: metric, namespace, ...(namespace === "AWS/EC2" ? {} : { dimensions: { Environment: E } }), alarm_actions: [], ok_actions: [], insufficient_data_actions: null, tags: hostTags });

/** The single-host surface, as created (after values; unknown ids). */
function hostSurface(): Array<{ type: string; name: string; index?: string | number; after: Obj; unknown: Obj }> {
  const id = { id: true, arn: true };
  return [
    {
      type: "aws_instance",
      name: "host",
      after: {
        ami: "ami-0123456789abcdef0",
        instance_type: "t4g.small",
        iam_instance_profile: `gs-${E}-host-app`,
        monitoring: false,
        user_data_replace_on_change: true,
        disable_api_termination: true,
        credit_specification: [{ cpu_credits: "standard" }],
        metadata_options: [{ http_endpoint: "enabled", http_tokens: "required", http_put_response_hop_limit: 2, http_protocol_ipv6: "disabled", instance_metadata_tags: "disabled" }],
        primary_network_interface: [{ network_interface_id: null }],
        root_block_device: [{ encrypted: true, volume_type: "gp3", volume_size: 20, delete_on_termination: true }],
        key_name: null,
        tags: { ...hostTags, Name: `gs-${E}-host` },
      },
      unknown: { ...id, public_ip: true, private_ip: true, primary_network_interface: [{ network_interface_id: true }] },
    },
    { type: "aws_network_interface", name: "host", after: { subnet_id: "subnet-0bbbbbbbbbbbbbbb1", source_dest_check: true, description: `18Cosmos ${E} single host (survives host replacement)`, security_groups: null }, unknown: { ...id, security_groups: true } },
    { type: "aws_eip", name: "host", after: { domain: "vpc", tags: { ...hostTags, Name: `gs-${E}-host` } }, unknown: { ...id, public_ip: true, allocation_id: true } },
    { type: "aws_eip_association", name: "host", after: { allocation_id: null, network_interface_id: null }, unknown: { id: true, allocation_id: true, network_interface_id: true } },
    { type: "aws_security_group", name: "host", after: { name: `gs-${E}-host`, vpc_id: "vpc-0123456789abcdef0", ingress: null, egress: null }, unknown: { ...id, ingress: true, egress: true } },
    { type: "aws_vpc_security_group_ingress_rule", name: "https_from_cloudfront", after: { ip_protocol: "tcp", from_port: 443, to_port: 443, prefix_list_id: "pl-3b927c52", security_group_id: null }, unknown: { ...id, security_group_id: true } },
    { type: "aws_vpc_security_group_ingress_rule", name: "acme_http01", after: { ip_protocol: "tcp", from_port: 80, to_port: 80, cidr_ipv4: "0.0.0.0/0", security_group_id: null }, unknown: { ...id, security_group_id: true } },
    { type: "aws_vpc_security_group_egress_rule", name: "https", index: "443", after: { ip_protocol: "tcp", from_port: 443, to_port: 443, cidr_ipv4: "0.0.0.0/0", security_group_id: null }, unknown: { ...id, security_group_id: true } },
    { type: "aws_iam_role", name: "host", after: { name: `gs-${E}-host-app`, max_session_duration: 3600, assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Sid: "Ec2ThisAccountOnly", Effect: "Allow", Action: "sts:AssumeRole", Principal: { Service: "ec2.amazonaws.com" }, Condition: { StringEquals: { "aws:SourceAccount": APP } } }] }) }, unknown: { ...id, unique_id: true } },
    { type: "aws_iam_instance_profile", name: "host", after: { name: `gs-${E}-host-app`, role: `gs-${E}-host-app` }, unknown: { ...id, unique_id: true } },
    { type: "aws_iam_role_policy", name: "host", after: { name: "gs-single-host-runtime", role: null, policy: hostPolicy() }, unknown: { id: true, role: true } },
    { type: "aws_cloudwatch_log_group", name: "host", after: { name: `/gs/${E}/host`, retention_in_days: 90, log_group_class: "STANDARD" }, unknown: id },
    { type: "aws_cloudwatch_metric_alarm", name: "health", after: alarm("health", "HostHealthProblems", "18Cosmos/GameServer"), unknown: id },
    { type: "aws_cloudwatch_metric_alarm", name: "critical", after: alarm("critical-event", "HostCriticalEvents", "18Cosmos/GameServer"), unknown: id },
    { type: "aws_cloudwatch_metric_alarm", name: "status_check", after: alarm("status-check", "StatusCheckFailed", "AWS/EC2"), unknown: id },
    { type: "aws_cloudwatch_metric_alarm", name: "pressure", after: alarm("pressure", "HostPressure", "18Cosmos/Host"), unknown: id },
    { type: "aws_cloudwatch_metric_alarm", name: "cpu_credits", after: alarm("cpu-credits", "CPUCreditBalance", "AWS/EC2"), unknown: id },
    { type: "aws_budgets_budget", name: "monthly", index: 0, after: { name: `gs-${E}-monthly-ceiling`, budget_type: "COST", limit_amount: "30.00", limit_unit: "USD", time_unit: "MONTHLY" }, unknown: id },
  ];
}

const hostVariables = (manageEcr: boolean): Obj => ({
  region: R,
  app_account_id: APP,
  environment: E,
  pool: "p1",
  generation: 1,
  game_generations: [1],
  ledger_table_arn: LEDGER_ARN,
  signing_keys: { relayer: KEYS.relayer, settlement: KEYS.settlement, admission: KEYS.admission },
  escrow_enabled: true,
  money_tables_nonmainnet: true,
  edge_diagnostic_staging: true,
  network: { vpc_id: "vpc-0123456789abcdef0", subnet_id: "subnet-0bbbbbbbbbbbbbbb1", juno_egress_ports: [443] },
  instance: { type: "t4g.small", ami_id: "ami-0123456789abcdef0", root_volume_gb: 20 },
  origin_hostname: FIXTURE.hostOrigin,
  allowed_origins: ["https://play.example.org"],
  trusted_proxy_hops: 2,
  manage_ecr_lifecycle: manageEcr,
  ecr_keep_images: 20,
  alarm_action_arns: [],
  ssm_agent: true,
  emergency_ssh_cidrs: [],
  termination_protection: true,
  budget: { enabled: true, limit_usd: 30, email_addresses: ["owner@example.org"] },
  tags: {},
});

function hostCreatePlan(): Obj {
  const rcs: Rc[] = hostSurface().map((s) => ({ module: HM, type: s.type, name: s.name, index: s.index, actions: ["create"], before: null, after: s.after, afterUnknown: s.unknown }));
  return planEnvelope(hostVariables(false), rcs, null);
}

function ecrLifecyclePlan(): Obj {
  const existing: Rc[] = hostSurface().map((s) => noop(HM, s.type, s.name, { ...s.after, id: `${s.type}-${s.name}` }, s.index));
  const policy = jsonencode({
    rules: [
      { rulePriority: 1, description: "Untagged layers/manifests (failed or superseded pushes) after 7 days", selection: { tagStatus: "untagged", countType: "sinceImagePushed", countUnit: "days", countNumber: 7 }, action: { type: "expire" } },
      { rulePriority: 2, description: "Keep the newest 20 images (rollback history)", selection: { tagStatus: "any", countType: "imageCountMoreThan", countNumber: 20 }, action: { type: "expire" } },
    ],
  });
  const rcs: Rc[] = [...existing, { module: HM, type: "aws_ecr_lifecycle_policy", name: "server", index: 0, actions: ["create"], before: null, after: { repository: `gs-${E}-server`, policy }, afterUnknown: { id: true, registry_id: true } }];
  return planEnvelope(hostVariables(true), rcs, priorState(HM, existing));
}

/* ------------------------------------------------------------------ */
/* The app stack                                                        */
/* ------------------------------------------------------------------ */

const AM = "module.app";
const appTags = { "gs:environment": E, "gs:slice": "live5-l5-8" };

export function runtimeDocument(pools: readonly string[], pool = "p1"): string {
  return jsonencode({
    format: "18COSMOS/AWS-RUNTIME/v2",
    environment: E,
    region: R,
    pool,
    generation: 1,
    game_table: G1,
    identity_table: IDENTITY,
    ledger_table_arn: LEDGER_ARN,
    escrow: { config_parameter_arn: JUNO },
    routes: Object.fromEntries(pools.map((p) => [p, { ws_path: `/gs/p/${p}` }])),
  });
}

const bootstrapPolicy = (pools: readonly string[]): string =>
  policyDocument([
    { Sid: "RoutingItemOnly", Action: ["dynamodb:GetItem", "dynamodb:PutItem"], Resource: [table(G1)], Condition: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": ["SYSTEM"] } } },
    { Sid: "DescribeTables", Action: ["dynamodb:DescribeContinuousBackups", "dynamodb:DescribeTable", "dynamodb:DescribeTimeToLive"], Resource: [table(G1), table(IDENTITY), LEDGER_ARN] },
    { Sid: "ReadConfiguration", Action: ["ssm:GetParameter"], Resource: [...pools.map(RUNTIME), JUNO] },
    { Sid: "SigningKeysReadOnly", Action: ["kms:DescribeKey", "kms:GetPublicKey", "kms:ListGrants"], Resource: [KEYS.admission, KEYS.relayer, KEYS.settlement] },
    { Sid: "VerifierDescribeServices", Action: ["ecs:DescribeServices"], Resource: [`arn:aws:ecs:${R}:${APP}:service/gs-${E}/*`] },
  ]);
const operatorPolicy = (pools: readonly string[]): string =>
  policyDocument([
    { Sid: "GameTableRead", Action: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan"], Resource: [table(G1)] },
    { Sid: "LedgerRead", Action: ["dynamodb:GetItem", "dynamodb:Scan"], Resource: [LEDGER_ARN] },
    { Sid: "ReadConfiguration", Action: ["ssm:GetParameter"], Resource: [...pools.map(RUNTIME), JUNO] },
    { Sid: "FlipWindowMetricsOnly", Action: ["cloudwatch:PutMetricData"], Resource: ["*"], Condition: { StringEquals: { "cloudwatch:namespace": ["18Cosmos/Operator"] } } },
  ]);

const ssmValues = (name: string, value: string, version: number): Obj => ({ name, arn: param(name), type: "String", data_type: "text", tier: "Intelligent-Tiering", insecure_value: value, value: null, version, has_value_wo: null, key_id: "", tags: appTags, tags_all: tagsAll(appTags, "app") });

function distributionValues(gsOrigin: string): Obj {
  const custom = (extra: Obj) => [{ http_port: 80, https_port: 443, origin_protocol_policy: "https-only", origin_ssl_protocols: ["TLSv1.2"], origin_keepalive_timeout: 5, origin_read_timeout: 30, ip_address_type: "", ...extra }];
  const origin = (id: string, domain: string, extra: Obj = {}) => ({ origin_id: id, domain_name: domain, origin_path: "", connection_attempts: 3, connection_timeout: 10, origin_access_control_id: "", custom_header: [], origin_shield: [], s3_origin_config: [], vpc_origin_config: [], custom_origin_config: custom(extra) });
  return {
    id: "E2EXAMPLE123",
    arn: `arn:aws:cloudfront::${APP}:distribution/E2EXAMPLE123`,
    caller_reference: "terraform-20260930",
    domain_name: "d111111abcdef8.cloudfront.net",
    hosted_zone_id: "Z2FDTNDATAQYW2",
    enabled: true,
    is_ipv6_enabled: true,
    http_version: "http2and3",
    price_class: "PriceClass_100",
    aliases: ["play.example.org"],
    comment: `18Cosmos ${E}: the site and /gs* (the game server)`,
    default_root_object: "",
    web_acl_id: "",
    retain_on_delete: false,
    wait_for_deployment: true,
    staging: false,
    continuous_deployment_policy_id: "",
    etag: "E1ETAG000001",
    last_modified_time: "2026-09-30 12:00:00 +0000 UTC",
    status: "Deployed",
    in_progress_validation_batches: 0,
    trusted_key_groups: [{ enabled: false, items: [] }],
    trusted_signers: [{ enabled: false, items: [] }],
    origin: [origin("site", "site.example.org"), origin("gs-alb", gsOrigin, { origin_read_timeout: 60 })],
    origin_group: [],
    default_cache_behavior: [{ target_origin_id: "site", viewer_protocol_policy: "redirect-to-https", allowed_methods: ["GET", "HEAD", "OPTIONS"], cached_methods: ["GET", "HEAD"], cache_policy_id: CACHING_OPTIMIZED, origin_request_policy_id: "", compress: true }],
    ordered_cache_behavior: [
      { path_pattern: "/gs*", target_origin_id: "gs-alb", viewer_protocol_policy: "https-only", allowed_methods: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"], cached_methods: ["GET", "HEAD"], cache_policy_id: CACHING_DISABLED, origin_request_policy_id: "orp-gs-all-query-cookies", compress: false },
    ],
    restrictions: [{ geo_restriction: [{ restriction_type: "none", locations: [] }] }],
    viewer_certificate: [{ acm_certificate_arn: `arn:aws:acm:us-east-1:${APP}:certificate/44444444-4444-4444-8444-444444444444`, ssl_support_method: "sni-only", minimum_protocol_version: "TLSv1.2_2021", cloudfront_default_certificate: false, iam_certificate_id: "" }],
    tags: appTags,
    tags_all: tagsAll(appTags, "app"),
  };
}

const ALARM_KEYS = ["a1-unexpected-task-loss", "p1/a5-money-sweep-stale", "p2/a5-money-sweep-stale", "p1/a11-readiness-flapping", "p2/a11-readiness-flapping", "primary/a6-relayer-unusable", "primary/a13-primary-heartbeat"];
const SUPPRESSIBLE = ["p1/a11-readiness-flapping", "p2/a11-readiness-flapping", "primary/a6-relayer-unusable", "primary/a13-primary-heartbeat"];

const serviceValues = (pool: string, desired: number): Obj => ({
  name: `gs-${E}-${pool}`,
  id: `arn:aws:ecs:${R}:${APP}:service/gs-${E}/gs-${E}-${pool}`,
  cluster: `arn:aws:ecs:${R}:${APP}:cluster/gs-${E}`,
  task_definition: `arn:aws:ecs:${R}:${APP}:task-definition/gs-${E}-${pool}:7`,
  desired_count: desired,
  launch_type: "FARGATE",
  platform_version: "1.4.0",
  scheduling_strategy: "REPLICA",
  deployment_minimum_healthy_percent: 0,
  deployment_maximum_percent: 100,
  availability_zone_rebalancing: "DISABLED",
  enable_execute_command: false,
  force_new_deployment: true,
  wait_for_steady_state: false,
  triggers: { runtime_document: `sha-${pool}`, juno_document: "sha-juno" },
  tags: { ...appTags, "gs:pool": pool },
});

/** The app stack's state today (ECS era, drained), resource by resource: [rc template, ECS-era?]. */
function appState(): Array<{ rc: Rc; ecs: boolean; p2doc?: boolean }> {
  const v = (values: Obj): Obj => ({ ...values });
  const s = (type: string, name: string, values: Obj, index?: string | number, ecs = false) => ({ rc: noop(AM, type, name, v(values), index), ecs });
  const pools = ["p1", "p2"];
  return [
    s("aws_dynamodb_table", "game", { name: G1, arn: table(G1), deletion_protection_enabled: true, point_in_time_recovery: [{ enabled: true, recovery_period_in_days: 35 }], ttl: [{ enabled: true, attribute_name: "ttl" }], tags: { ...appTags, Name: G1, "gs:component": "game", "gs:generation": "1", "gs:serving": "true" } }, "1"),
    s("aws_dynamodb_table", "identity", { name: IDENTITY, arn: table(IDENTITY), deletion_protection_enabled: true, point_in_time_recovery: [{ enabled: true, recovery_period_in_days: 35 }], ttl: [{ enabled: true, attribute_name: "ttl" }] }),
    s("aws_ssm_parameter", "runtime", ssmValues(`/gs/${E}/runtime/p1`, runtimeDocument(pools, "p1"), 3), "p1"),
    { ...s("aws_ssm_parameter", "runtime", ssmValues(`/gs/${E}/runtime/p2`, runtimeDocument(pools, "p2"), 3), "p2"), p2doc: true },
    s("aws_ssm_parameter", "juno_backend", ssmValues(`/gs/${E}/juno-backend`, jsonencode({ format: "18COSMOS/JUNO-BACKEND/v3", chain_id: "uni-7" }), 2), 0),
    s("aws_ecr_repository", "server", { name: `gs-${E}-server`, image_tag_mutability: "IMMUTABLE", force_delete: false }),
    s("aws_cloudfront_origin_request_policy", "gs", { name: `gs-${E}-gs-all-query-cookies-origin`, id: "orp-gs-all-query-cookies", query_strings_config: [{ query_string_behavior: "all", query_strings: [] }] }),
    s("aws_cloudfront_distribution", "site", distributionValues(FIXTURE.albOrigin), 0),
    s("aws_iam_role", "bootstrap", { name: `gs-${E}-bootstrap`, arn: BOOT_ROLE }),
    s("aws_iam_role_policy", "bootstrap", { name: "gs-bootstrap", role: `gs-${E}-bootstrap`, policy: bootstrapPolicy(pools) }),
    s("aws_iam_role", "operator", { name: `gs-${E}-operator`, arn: OPER_ROLE }, 0),
    s("aws_iam_role_policy", "operator", { name: "gs-operator", role: `gs-${E}-operator`, policy: operatorPolicy(pools) }, 0),
    s("aws_iam_role", "task", { name: `gs-${E}-app-task`, arn: TASK_ROLE }, 0, true),
    s("aws_iam_role_policy", "task", { name: "gs-runtime", role: `gs-${E}-app-task`, policy: policyDocument([{ Sid: "ReadConfiguration", Action: ["ssm:GetParameter"], Resource: [RUNTIME("p1"), RUNTIME("p2"), JUNO] }]) }, 0, true),
    s("aws_iam_role", "execution", { name: `gs-${E}-app-execution`, arn: role("app-execution") }, 0, true),
    s("aws_iam_role_policy", "execution", { name: "gs-execution", role: `gs-${E}-app-execution`, policy: policyDocument([{ Sid: "PullImage", Action: ["ecr:GetAuthorizationToken"], Resource: ["*"] }]) }, 0, true),
    s("aws_ecs_cluster", "this", { name: `gs-${E}`, arn: `arn:aws:ecs:${R}:${APP}:cluster/gs-${E}` }, 0, true),
    ...pools.map((p) => s("aws_cloudwatch_log_group", "pool", { name: `/gs/${E}/${p}`, retention_in_days: 365 }, p, true)),
    ...pools.map((p) => s("aws_ecs_task_definition", "pool", { family: `gs-${E}-${p}`, revision: 7, skip_destroy: true, task_role_arn: TASK_ROLE }, p, true)),
    /* THE DRIFT: the state remembers desired 1 for both pools; live staging is 0/0/0. */
    ...pools.map((p) => s("aws_ecs_service", "pool", serviceValues(p, 1), p, true)),
    s("aws_lb", "this", { name: `gs-${E}-alb`, load_balancer_type: "application", enable_deletion_protection: false }, 0, true),
    s("aws_lb_listener", "https", { port: 443, protocol: "HTTPS" }, 0, true),
    s("aws_lb_listener_rule", "gs", { priority: 1000 }, 0, true),
    ...pools.map((p, i) => s("aws_lb_listener_rule", "pool", { priority: 100 + i }, p, true)),
    ...pools.map((p) => s("aws_lb_target_group", "pool", { name: `gs-${E}-${p}`, target_type: "ip" }, p, true)),
    s("aws_security_group", "alb", { name: `gs-${E}-alb` }, 0, true),
    s("aws_vpc_security_group_ingress_rule", "alb_from_cloudfront", { from_port: 443, to_port: 443 }, 0, true),
    s("aws_vpc_security_group_egress_rule", "alb_to_tasks", { from_port: 8917, to_port: 8917 }, 0, true),
    s("aws_security_group", "task", { name: `gs-${E}-task` }, 0, true),
    s("aws_vpc_security_group_ingress_rule", "task_from_alb", { from_port: 8917, to_port: 8917 }, 0, true),
    s("aws_vpc_security_group_egress_rule", "task_https", { from_port: 443, to_port: 443 }, "443", true),
    ...["dynamodb", "s3"].map((k) => s("aws_vpc_endpoint", "gateway", { service_name: `com.amazonaws.${R}.${k}`, vpc_endpoint_type: "Gateway" }, k, true)),
    s("aws_security_group", "endpoints", { name: `gs-${E}-endpoints` }, 0, true),
    s("aws_vpc_security_group_ingress_rule", "endpoints_from_tasks", { from_port: 443, to_port: 443 }, 0, true),
    ...["ecr.api", "ecr.dkr", "kms", "logs", "ssm"].map((k) => s("aws_vpc_endpoint", "interface", { service_name: `com.amazonaws.${R}.${k}`, vpc_endpoint_type: "Interface", private_dns_enabled: true }, k, true)),
    ...pools.map((p) => s("aws_cloudwatch_metric_alarm", "flip_window", { alarm_name: `gs-${E}-${p}-flip-window` }, p, true)),
    ...ALARM_KEYS.map((k) => s("aws_cloudwatch_metric_alarm", "gs", { alarm_name: `gs-${E}-${k.replace("/", "-")}` }, k, true)),
    ...SUPPRESSIBLE.map((k) => s("aws_cloudwatch_composite_alarm", "notify", { alarm_name: `gs-${E}-${k.replace("/", "-")}-notify` }, k, true)),
  ];
}

const tableItem = (name: string, item: Obj): Rc => ({ module: AM, mode: "data", type: "aws_dynamodb_table_item", name, index: 0, actions: ["read"], before: { table_name: G1, key: "", item: JSON.stringify(item) }, after: null });
const ROUTING_ITEM = tableItem("routing", { pk: { S: "SYSTEM" }, sk: { S: "ROUTING" }, fmt: { N: "1" }, primary_pool: { S: "p1" }, routing_version: { N: "3" } });
const GENERATION_ITEM = tableItem("generation", { pk: { S: "SYSTEM" }, sk: { S: "GENERATION" }, fmt: { N: "1" }, generation: { N: "1" }, game_table: { S: G1 }, origin: { S: "bootstrap" }, restore_id: { NULL: true } });

const appVariables = (overrides: Obj): Obj => ({
  region: R,
  app_account_id: APP,
  environment: E,
  generation: 1,
  game_generations: [],
  generation_adoption: null,
  compute: "ecs",
  ledger_table_arn: LEDGER_ARN,
  signing_keys: { relayer: KEYS.relayer, settlement: KEYS.settlement, admission: KEYS.admission },
  relayer_rotation_key_arns: [],
  money_tables_nonmainnet: true,
  edge_diagnostic_staging: true,
  build_id: "c14186d",
  pools: { p1: { primary: true, desired_count: 1 }, p2: { primary: false, desired_count: 1 } },
  start_services: true,
  recovery_trusted_principal_arns: [],
  recovery_break_glass: false,
  operator_trusted_principal_arns: [`arn:aws:iam::${APP}:user/owner`],
  edge: { create_distribution: true, aliases: ["play.example.org"], alb_origin_domain_name: FIXTURE.albOrigin, site_origin_domain_name: "site.example.org" },
  ...overrides,
});

const drift = (pool: string): Obj => ({
  address: `${AM}.aws_ecs_service.pool["${pool}"]`,
  module_address: AM,
  mode: "managed",
  type: "aws_ecs_service",
  name: "pool",
  index: pool,
  provider_name: PROVIDER,
  change: { actions: ["update"], before: serviceValues(pool, 1), after: serviceValues(pool, 0), after_unknown: {}, before_sensitive: {}, after_sensitive: {} },
});

function appPrior(): Obj {
  return priorState(
    AM,
    appState().map((x) => x.rc),
    [ROUTING_ITEM, GENERATION_ITEM].map((d) => ({ ...d, before: d.before })),
  );
}

/** step 14: a TARGETED plan (-target=module.app.aws_cloudfront_distribution.site[0]) moving /gs* to the host. */
function edgeCutoverPlan(): Obj {
  const before = distributionValues(FIXTURE.albOrigin);
  const after = { ...distributionValues(FIXTURE.hostOrigin), etag: null, last_modified_time: null, status: null };
  const rcs: Rc[] = [
    { module: AM, type: "aws_cloudfront_distribution", name: "site", index: 0, actions: ["update"], before, after, afterUnknown: { etag: true, last_modified_time: true, status: true } },
    appState().find((x) => x.rc.type === "aws_cloudfront_origin_request_policy")!.rc,
  ];
  return planEnvelope(appVariables({ edge: { create_distribution: true, aliases: ["play.example.org"], alb_origin_domain_name: FIXTURE.hostOrigin, site_origin_domain_name: "site.example.org" } }), rcs, appPrior());
}

/** The rollback before step 14: p1's service 0 -> 1 (refreshed from the live 0), p2 configured at 0. */
function ecsRollbackPlan(): Obj {
  const rcs: Rc[] = appState().map(({ rc }) => {
    if (rc.type !== "aws_ecs_service") return rc;
    const pool = String(rc.index);
    return pool === "p1" ? { ...rc, actions: ["update"], before: serviceValues("p1", 0), after: serviceValues("p1", 1) } : { ...rc, before: serviceValues(pool, 0), after: serviceValues(pool, 0) };
  });
  return planEnvelope(appVariables({ pools: { p1: { primary: true, desired_count: 1 }, p2: { primary: false, desired_count: 0 } } }), rcs, appPrior(), [drift("p1"), drift("p2")]);
}

/** step 20: compute = "none", start_services = true, pools = { p1 = { primary = true } }. */
function computeNonePlan(): Obj {
  const rcs: Rc[] = appState().map(({ rc, ecs, p2doc }) => {
    if (ecs || p2doc) return { ...rc, actions: ["delete"], after: null, reason: typeof rc.index === "string" ? "delete_because_each_key" : "delete_because_count_index" };
    if (rc.type === "aws_ssm_parameter" && rc.index === "p1") return { ...rc, actions: ["update"], after: { ...rc.before, insecure_value: runtimeDocument(["p1"]), version: null }, afterUnknown: { version: true } };
    if (rc.type === "aws_iam_role_policy" && rc.name === "bootstrap") return { ...rc, actions: ["update"], after: { ...rc.before, policy: bootstrapPolicy(["p1"]) } };
    if (rc.type === "aws_iam_role_policy" && rc.name === "operator") return { ...rc, actions: ["update"], after: { ...rc.before, policy: operatorPolicy(["p1"]) } };
    return rc;
  });
  return planEnvelope(appVariables({ compute: "none", pools: { p1: { primary: true, desired_count: 1 } }, edge: { create_distribution: true, aliases: ["play.example.org"], alb_origin_domain_name: FIXTURE.hostOrigin, site_origin_domain_name: "site.example.org" } }), rcs, appPrior(), [drift("p1"), drift("p2")]);
}

/* ------------------------------------------------------------------ */
/* All of them                                                          */
/* ------------------------------------------------------------------ */

export function validPlans(): Readonly<Record<GateName, Obj>> {
  return {
    "ledger-host-authorize": ledgerPlan([TASK_ROLE], [TASK_ROLE, HOST_ROLE], true),
    "host-create": hostCreatePlan(),
    "edge-cutover": edgeCutoverPlan(),
    "ecs-rollback": ecsRollbackPlan(),
    "compute-none": computeNonePlan(),
    "ledger-task-deauthorize": ledgerPlan([TASK_ROLE, HOST_ROLE], [HOST_ROLE], false),
    "ecr-lifecycle": ecrLifecyclePlan(),
  };
}

export const FIXTURE_DIR = "infra/aws/fixtures/migration-plans";
export const fixtureText = (plan: Obj): string => `${JSON.stringify(plan, null, 2)}\n`;

/* `node planFixtures.js --write`: regenerate the committed copies (from the repository root's dist build). */
if (require.main === module && process.argv.includes("--write")) {
  const repo = path.resolve(__dirname, "../../../../../../..");
  for (const [gate, plan] of Object.entries(validPlans())) fs.writeFileSync(path.join(repo, FIXTURE_DIR, `${gate}.json`), fixtureText(plan));
  // eslint-disable-next-line no-console
  console.log(`wrote ${Object.keys(validPlans()).length} fixtures to ${FIXTURE_DIR}`);
}
