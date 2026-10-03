// server/src/aws/deploy/hostVerify.ts
//
// ==================================================================
//  COST-2A: THE SINGLE-HOST CONTROL PLANE, JUDGED FROM EVIDENCE -- PURE CHECKS, THREE ANSWERS: PASS / FAIL / NOT EVALUATED
// ==================================================================
//
// COST-1 moved the deployment from ECS + ALB to ONE EC2 host behind the SAME CloudFront distribution, against the SAME
// DynamoDB tables, ledger, KMS keys and SSM documents. The DATA-PLANE half of `awsDeploy verify` (the documents by the
// task's own code, the tables, APPGEN / SYSTEM/ROUTING / SYSTEM/GENERATION, the KMS keys) is unchanged and runs for every
// topology. This module is the CONTROL-PLANE half for the host, in the L5-8 style: the server carries no EC2 / IAM / ECS /
// ELB / CloudFront SDK; it judges the JSON the read-only AWS CLI printed (infra/aws/scripts/capture-host-evidence.{sh,ps1})
// and the operator's read-only runtime snapshot (`gamesDoctor aws host-snapshot`). Nothing here reads AWS, writes
// anything or holds a credential.
//
// THREE ANSWERS, NEVER COLLAPSED (the COST-2A rule):
//   pass           the evidence was read and shows the property;
//   fail           the evidence was read and shows the property does NOT hold (or the evidence is stale or for another
//                  deployment);
//   not-evaluated  the evidence for it is missing, was written as an error, or is not the answer the property needs (a
//                  listing without its list). It NEVER becomes a pass: in particular an ABSENCE check ("no ALB") passes only
//                  on a listing that was READ COMPLETELY and is empty of the thing -- a failed read is not an empty one.
//   skipped        reserved for what the caller explicitly put out of scope (the budget in another account, the Terraform
//                  outputs not captured, a host not yet created in coexistence); named, never silent.
// The verdict: any fail -> FAIL; else any not-evaluated -> NOT EVALUATED; else PASS (`commands.ts` report()).
//
// TOPOLOGIES (`--topology`; `ecs`, the default, is L5-8 / L6-2's `checkEvidenceDirectory`, unchanged):
//   coexist      the migration (infra/aws/SINGLE_HOST_MIGRATION.md D-I): the ECS / ALB resources MAY still exist, but
//                DRAINED (no service task desired, running or pending; no target registered) -- the host is the only
//                serving writer; the host itself is fully verified (or explicitly not yet created: `--instance-id none`);
//                NAT, endpoints and the L6-5B alarm matrix are tolerated and reported.
//   single-host  the final state (after step I): every ECS-era fixed-cost resource is ABSENT (no ECS cluster or service, no
//                load balancer or target group, no interface endpoint, no NAT unless named as another workload's, no
//                L6-5B alarm, no pool log group, no ECS-era security group) and there is exactly ONE host and ONE host EIP.
// In both: the authoritative DynamoDB tables, ledger, KMS keys and SSM documents are the ONE set the runtime document names
// -- the host role may reach exactly those, and the identity writer and relayer are held by the host pool's CURRENT task
// (a role held elsewhere is a second serving writer).
//
// SECRETS: the captures hold describes only (no user data, no parameter value, no secret, no budget subscriber), the host
// line is `gs-health`'s (states, codes, digests, build id, and whether a static credential is PRESENT -- never its value).
// Every detail here names identifiers and states; nothing copies a document's content.

import * as fs from "fs";
import * as path from "path";

import { expectedAlarms, suppressorName } from "../controlPlane/alarmContract";
import { checkEdgeEvidence } from "./deployVerify";

/* ------------------------------------------------------------------ */
/* Checks                                                               */
/* ------------------------------------------------------------------ */

export type HostCheckStatus = "pass" | "fail" | "not-evaluated" | "skipped";

export interface HostCheck {
  readonly name: string;
  readonly status: HostCheckStatus;
  readonly detail: string;
}

const pass = (name: string, detail: string): HostCheck => ({ name, status: "pass", detail });
const fail = (name: string, detail: string): HostCheck => ({ name, status: "fail", detail });
const notEvaluated = (name: string, detail: string): HostCheck => ({ name, status: "not-evaluated", detail });
const skip = (name: string, detail: string): HostCheck => ({ name, status: "skipped", detail });
const judge = (name: string, ok: boolean, good: string, bad: string): HostCheck => (ok ? pass(name, good) : fail(name, bad));

export const HOST_TOPOLOGIES = Object.freeze(["coexist", "single-host"] as const);
export type HostTopology = (typeof HOST_TOPOLOGIES)[number];

/** The capture's own statement (`manifest.json`). */
export const HOST_EVIDENCE_FORMAT = "18COSMOS/HOST-EVIDENCE/v1";
/** `gamesDoctor aws host-snapshot` (aws/operator/hostSnapshot.ts). */
export const HOST_RUNTIME_SNAPSHOT_FORMAT = "18COSMOS/HOST-RUNTIME-SNAPSHOT/v1";
/** `awsDeploy verify --report <dir>`: the machine-readable evidence. */
export const HOST_REPORT_FORMAT = "18COSMOS/HOST-VERIFY-REPORT/v1";

/** COST-1's allow-list (infra/aws/COST_BUDGET.json `allowed_instance_types`; pinned by cost2aHostVerifier.test.ts). */
export const HOST_INSTANCE_TYPES: readonly string[] = Object.freeze(["t4g.small", "t4g.micro", "t3.small", "t3.micro"]);
/** The owner's hard ceiling (COST_BUDGET.json `hard_maximum_monthly`), in whole cents. */
export const BUDGET_CEILING_CENTS = 3000;
export const CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST = "com.amazonaws.global.cloudfront.origin-facing";
/** The single-host module's inline policy name and the host role / profile / SG / log group naming (modules/single-host). */
export const HOST_POLICY_NAME = "gs-single-host-runtime";
export const HOST_METRIC_NAMESPACE = "18Cosmos/Host";
export const APP_METRIC_NAMESPACE = "18Cosmos/GameServer";
/** Owner classes of an ordinary serving state (as `gamesDoctor aws games`). */
const SETTLED_OWNERS: readonly string[] = Object.freeze(["released", "current", "superseded", "no-head"]);

export const hostNames = (environment: string) => ({
  prefix: `gs-${environment}-`,
  host: `gs-${environment}-host`,
  role: `gs-${environment}-host-app`,
  securityGroup: `gs-${environment}-host`,
  logGroup: `/gs/${environment}/host`,
  logGroupPrefix: `/gs/${environment}/`,
  ecrRepository: `gs-${environment}-server`,
  cluster: `gs-${environment}`,
  budget: `gs-${environment}-monthly-ceiling`,
  originRequestPolicy: `gs-${environment}-gs-all-query-cookies-origin`,
  /** The ECS era's security groups (modules/app network.tf): absent in the final state. */
  legacySecurityGroups: [`gs-${environment}-task`, `gs-${environment}-alb`, `gs-${environment}-endpoints`],
  alarms: {
    health: `gs-${environment}-host-health`,
    critical: `gs-${environment}-host-critical-event`,
    statusCheck: `gs-${environment}-host-status-check`,
    pressure: `gs-${environment}-host-pressure`,
    cpuCredits: `gs-${environment}-host-cpu-credits`,
  },
});

/** The evidence files (the capture scripts write exactly these names; a failed call writes `<base>.error.json`). */
export const HOST_EVIDENCE_FILES = Object.freeze({
  manifest: "manifest.json",
  callerIdentity: "caller-identity.json",
  instances: "instances.json",
  /** Every non-terminated instance holding the HOST ROLE's profile, tagged or not (a second holder is a second writer). */
  instancesByProfile: "instances-by-profile.json",
  creditSpecification: "credit-specification.json",
  terminationProtection: "termination-protection.json",
  volumes: "volumes.json",
  image: "image.json",
  networkInterfaces: "network-interfaces.json",
  addresses: "addresses.json",
  securityGroups: "security-groups.json",
  prefixList: "prefix-list.json",
  natGateways: "nat-gateways.json",
  vpcEndpoints: "vpc-endpoints.json",
  ssmInstance: "ssm-instance.json",
  instanceProfile: "instance-profile.json",
  role: "role.json",
  roleAttachedPolicies: "role-attached-policies.json",
  roleInlinePolicies: "role-inline-policies.json",
  rolePolicy: "role-policy.json",
  distributionConfig: "distribution-config.json",
  originRequestPolicy: "origin-request-policy.json",
  logGroups: "log-groups.json",
  /** The ECS era's Container Insights log groups (`/aws/ecs/containerinsights/gs-<env>/`): absent in the final state. */
  containerInsightsLogGroups: "container-insights-log-groups.json",
  alarms: "alarms.json",
  budgets: "budgets.json",
  ecsClusters: "ecs-clusters.json",
  ecsServices: "ecs-services.json",
  ecsRunningTasks: "ecs-running-tasks.json",
  loadBalancers: "load-balancers.json",
  targetGroups: "target-groups.json",
  targetHealth: (targetGroupName: string) => `target-health-${targetGroupName}.json`,
  hostHealth: "host-health.json",
  terraformOutputs: "terraform-outputs.json",
  runtimeSnapshot: "runtime-snapshot.json",
});

/* ------------------------------------------------------------------ */
/* Reading the directory: ok / absent / error -- never guessed            */
/* ------------------------------------------------------------------ */

type Json = unknown;
const obj = (value: Json): Record<string, Json> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json>) : {});
const arr = (value: Json): Json[] => (Array.isArray(value) ? value : []);
const str = (value: Json): string | null => (typeof value === "string" ? value : null);
const isArr = (value: Json): value is Json[] => Array.isArray(value);

export type HostRead = { readonly kind: "ok"; readonly value: Json } | { readonly kind: "unread"; readonly why: string };

/** Files that carry their own time and may be added after the capture (the operator's snapshot, `--host-status-only`). */
const OWN_TIME_FILES: ReadonlySet<string> = new Set(["manifest.json", "runtime-snapshot.json", "host-health.json"]);

/** The files THIS capture wrote (its manifest's calls), or null when the manifest cannot be read (then the manifest check is
 *  already NOT EVALUATED and no verdict can pass). */
function capturedFiles(dir: string): ReadonlySet<string> | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8").replace(/^\uFEFF/, "")) as { calls?: unknown };
    return Array.isArray(m.calls) ? new Set(m.calls.map((c) => String((c as { file?: unknown } | null)?.file))) : null;
  } catch {
    return null;
  }
}

/** One evidence file. Missing, written as an error by the capture, not JSON, or NOT PART OF THIS CAPTURE (a file an
 *  earlier capture left in the directory, which this one did not write): `unread` (with why), never a value. */
export function readHostEvidence(dir: string, file: string): HostRead {
  if (!OWN_TIME_FILES.has(file)) {
    const calls = capturedFiles(dir);
    if (calls !== null && !calls.has(file) && fs.existsSync(path.join(dir, file))) return { kind: "unread", why: `${file} is not part of this capture (its manifest never wrote it: an earlier capture's file)` };
  }
  const errorFile = file.replace(/\.json$/, ".error.json");
  try {
    if (fs.existsSync(path.join(dir, errorFile))) {
      const error = obj(JSON.parse(fs.readFileSync(path.join(dir, errorFile), "utf8").replace(/^﻿/, "")));
      return { kind: "unread", why: `the capture's read failed (${errorFile}: ${String(error.error ?? "?").replace(/\s+/g, " ").slice(0, 200)})` };
    }
  } catch {
    return { kind: "unread", why: `the capture's read failed (${errorFile} present, not readable)` };
  }
  try {
    /* Windows PowerShell 5.1 writes UTF-8 with a byte-order mark; JSON.parse does not accept one. */
    return { kind: "ok", value: JSON.parse(fs.readFileSync(path.join(dir, file), "utf8").replace(/^﻿/, "")) as Json };
  } catch (error) {
    const missing = (error as { code?: string } | null)?.code === "ENOENT";
    return { kind: "unread", why: missing ? `${file} is not in the evidence` : `${file} is not JSON (${error instanceof Error ? error.message.slice(0, 120) : "?"})` };
  }
}

/** A listing's list, only when the answer HAS it (an answer without its list is not an empty listing). */
function listOf(read: HostRead, key: string): { readonly ok: true; readonly items: Array<Record<string, Json>> } | { readonly ok: false; readonly why: string } {
  if (read.kind !== "ok") return { ok: false, why: read.why };
  const list = obj(read.value)[key];
  if (!isArr(list)) return { ok: false, why: `the answer has no ${key} list` };
  return { ok: true, items: list.map(obj) };
}

/** A time (ISO-8601 or epoch seconds/ms), in ms. */
export function evidenceTime(value: Json): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** An AWS CLI policy document: an object (CLI v2 decodes it) or a URL-encoded JSON string (the raw API). */
export function policyDocument(value: Json): Record<string, Json> | null {
  if (typeof value === "string") {
    try {
      let text = value;
      if (/%[0-9A-Fa-f]{2}/.test(text)) text = decodeURIComponent(text);
      return obj(JSON.parse(text));
    } catch {
      return null;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json>) : null;
}

const tagsOf = (item: Record<string, Json>): Map<string, string> => new Map(arr(item.Tags ?? item.TagSet).map(obj).map((t) => [String(t.Key), String(t.Value)] as const));

/** "30.0" / "30" / "29.99" as whole cents, by string arithmetic (no floating point). */
export function usdCents(text: Json): number | null {
  if (typeof text !== "string" && typeof text !== "number") return null;
  const m = /^([0-9]{1,9})(?:\.([0-9]{1,8}))?$/.exec(String(text));
  if (m === null) return null;
  const frac = (m[2] ?? "").padEnd(2, "0");
  const extra = frac.slice(2).replace(/0/g, "");
  return Number(m[1]) * 100 + Number(frac.slice(0, 2)) + (extra.length > 0 ? 1 : 0); // round any sub-cent remainder UP
}

/* ------------------------------------------------------------------ */
/* What the checks compare against                                      */
/* ------------------------------------------------------------------ */

export interface HostExpect {
  readonly topology: HostTopology;
  readonly environment: string;
  /** The runtime document's region and the app account (the runtime parameter ARN's). */
  readonly region: string;
  readonly account: string;
  /** The host's pool: the routing's primary. */
  readonly pool: string;
  readonly generation: number;
  /** The expected host, or null: coexistence before the host exists (`--instance-id none`). */
  readonly instanceId: string | null;
  /** The host's origin name (stacks/single-host `origin_hostname`). */
  readonly originHostname: string | null;
  /** The /gs* origin's expected domain in this migration state. */
  readonly gsOrigin: string;
  /** The default (frontend) behaviour's origin domain; null: not stated (that check is NOT EVALUATED). */
  readonly siteOrigin: string | null;
  readonly instanceType: string | null;
  readonly emergencySsh: boolean;
  readonly junoEgressPorts: readonly number[];
  readonly budget: "required" | "not-required";
  readonly expectDigest: string | null;
  readonly expectBuild: string | null;
  readonly allowNatGateways: readonly string[];
  readonly allowVpcEndpoints: readonly string[];
  /** Unassociated Elastic IPs named as another workload's (`--allow-eip`): any other is a forgotten one in the final state. */
  readonly allowEips: readonly string[];
  /** The ECS era's VPC when it is not the host's (`--legacy-vpc`): its NAT gateways are judged too. */
  readonly legacyVpcs: readonly string[];
  /** Every pool the ECS era may have had (the route table's, p1, p2, `--legacy-pools`): its exact resource names. */
  readonly legacyPools: readonly string[];
  /** null: not stated -- the alarms' destinations are then NOT EVALUATED (`--alarm-actions none` states "none"). */
  readonly alarmActions: readonly string[] | null;
  /** The ONE set of authorities (from the runtime documents, parsed by the task's own code). */
  readonly authorities: {
    readonly gameTableArns: readonly string[];
    readonly identityTableArn: string;
    readonly ledgerTableArn: string;
    readonly runtimeParameterArn: string;
    readonly junoParameterArn: string | null;
    /** The escrow configuration's KMS keys (relayer, settlement, admission); null without escrow. */
    readonly kmsKeyArns: readonly string[] | null;
  };
  /** The configured relayer (escrow) and its RELAYQ, read live by the verifier (the rotation gate's own RELAYQ reader, in commands.ts); null: no escrow. */
  readonly relayer: { readonly address: string; readonly queue: { readonly state: "empty" } | { readonly state: "open"; readonly entries: number } | { readonly state: "unknown"; readonly detail: string } } | null;
  readonly now: number;
  readonly maxAgeMs: number;
}

/* ------------------------------------------------------------------ */
/* The manifest                                                         */
/* ------------------------------------------------------------------ */

function freshness(label: string, at: number | null, expect: HostExpect): HostCheck {
  if (at === null) return fail(label, "no capture time");
  const age = expect.now - at;
  return judge(label, age >= -60_000 && age <= expect.maxAgeMs, `captured ${Math.round(age / 1000)} s ago`, age < -60_000 ? `captured ${Math.round(-age / 1000)} s in the FUTURE (clock or forged evidence)` : `captured ${Math.round(age / 1000)} s ago; recapture (at most ${Math.round(expect.maxAgeMs / 60_000)} min old)`);
}

export function checkHostManifest(read: HostRead, expect: HostExpect, dir?: string): HostCheck[] {
  if (read.kind !== "ok") return [notEvaluated("host evidence manifest", `${read.why}: not a complete host capture (infra/aws/scripts/capture-host-evidence)`)];
  const m = obj(read.value);
  const instance = str(m.instance_id);
  const checks: HostCheck[] = [
    judge("host evidence manifest", m.format === HOST_EVIDENCE_FORMAT && m.environment === expect.environment && m.region === expect.region, `${HOST_EVIDENCE_FORMAT}, ${expect.environment}, ${expect.region}`, `format ${String(m.format)}, environment ${String(m.environment)}, region ${String(m.region)} (expected ${HOST_EVIDENCE_FORMAT}, ${expect.environment}, ${expect.region})`),
    judge("host evidence manifest: the host", (expect.instanceId ?? "none") === instance, `captured for ${instance}`, `captured for ${String(instance)}, verifying ${expect.instanceId ?? "none"}`),
    typeof m.account !== "string" || !/^[0-9]{12}$/.test(m.account)
      ? notEvaluated("host evidence manifest: account", "the capture could not read its account (sts get-caller-identity)")
      : judge("host evidence manifest: account", m.account === expect.account, `account ${expect.account}`, `captured in account ${m.account}, the runtime document's is ${expect.account}`),
    freshness("host evidence manifest: fresh", evidenceTime(m.captured_at), expect),
  ];
  /* The directory as it is NOW is the truth (`--host-status-only` may have added an answer after the manifest): a call is
     failed while its error file stands or its answer is missing. */
  const stillFailed = (file: string) => dir === undefined || fs.existsSync(path.join(dir, file.replace(/\.json$/, ".error.json"))) || !fs.existsSync(path.join(dir, file));
  if (!isArr(m.calls) || m.calls.length === 0) checks.push(notEvaluated("host evidence: every read succeeded", "the manifest lists no reads: not a capture this verifier can trust"));
  const failed = arr(m.calls).map(obj).filter((c) => c.ok === false && stillFailed(String(c.file))).map((c) => String(c.file));
  /* The capture's own STS answer must name the account the manifest states (a manifest is never taken on its word). */
  if (dir !== undefined) {
    const identity = readHostEvidence(dir, HOST_EVIDENCE_FILES.callerIdentity);
    if (identity.kind !== "ok") checks.push(notEvaluated("host evidence: the capture's identity", identity.why));
    else checks.push(judge("host evidence: the capture's identity", obj(identity.value).Account === m.account && m.account === expect.account, `sts get-caller-identity: ${expect.account}`, `the capture ran in ${String(obj(identity.value).Account)}; the manifest says ${String(m.account)}; the runtime document's account is ${expect.account}`));
  }
  if (!isArr(m.calls) || m.calls.length === 0) {
    /* reported above */
  } else if (failed.length > 0) checks.push(notEvaluated("host evidence: every read succeeded", `${failed.length} read(s) failed: ${failed.slice(0, 12).join(", ")}${failed.length > 12 ? ", ..." : ""} -- the checks that need them are NOT EVALUATED`));
  else checks.push(pass("host evidence: every read succeeded", `${arr(m.calls).length} read(s)`));
  return checks;
}

/* ------------------------------------------------------------------ */
/* EC2: the one host                                                    */
/* ------------------------------------------------------------------ */

/** Every non-terminated instance the single-host module tagged for this environment. */
function hostInstances(read: HostRead, environment: string): { readonly ok: true; readonly items: Array<Record<string, Json>> } | { readonly ok: false; readonly why: string } {
  const reservations = listOf(read, "Reservations");
  if (!reservations.ok) return reservations;
  const items = reservations.items
    .flatMap((r) => arr(r.Instances).map(obj))
    .filter((i) => {
      const tags = tagsOf(i);
      return tags.get("gs:environment") === environment && tags.get("gs:component") === "single-host" && obj(i.State).Name !== "terminated";
    });
  return { ok: true, items };
}

const archOfType = (type: string): string | null => (type.startsWith("t4g.") ? "arm64" : type.startsWith("t3.") ? "x86_64" : null);

/** Every non-terminated instance whose instance profile is the host role's (the capture's second listing): tags can be
 *  removed or never set, the role's authority cannot -- an untagged instance with the host profile is a second host. */
function profileInstances(read: HostRead, profileArn: string): { readonly ok: true; readonly items: Array<Record<string, Json>> } | { readonly ok: false; readonly why: string } {
  const reservations = listOf(read, "Reservations");
  if (!reservations.ok) return reservations;
  return { ok: true, items: reservations.items.flatMap((r) => arr(r.Instances).map(obj)).filter((i) => obj(i.State).Name !== "terminated" && obj(i.IamInstanceProfile).Arn === profileArn) };
}

export function checkHostInstance(dir: string, expect: HostExpect): { readonly checks: HostCheck[]; readonly host: Record<string, Json> | null } {
  const names = hostNames(expect.environment);
  const read = readHostEvidence(dir, HOST_EVIDENCE_FILES.instances);
  const tagged = hostInstances(read, expect.environment);
  const byProfile = profileInstances(readHostEvidence(dir, HOST_EVIDENCE_FILES.instancesByProfile), `arn:aws:iam::${expect.account}:instance-profile/${names.role}`);
  if (!tagged.ok) return { checks: [notEvaluated(expect.instanceId === null ? "EC2: no host yet (--instance-id none)" : "EC2: exactly one host", tagged.why)], host: null };
  if (!byProfile.ok) return { checks: [notEvaluated(expect.instanceId === null ? "EC2: no host yet (--instance-id none)" : "EC2: exactly one host", `the instances holding the host profile: ${byProfile.why}`)], host: null };
  const union = new Map<string, Record<string, Json>>();
  for (const i of [...tagged.items, ...byProfile.items]) if (!union.has(String(i.InstanceId))) union.set(String(i.InstanceId), i); // one describe, two filters: the tagged answer first
  const listed = { ok: true as const, items: [...union.values()] };
  const ids = listed.items.map((i) => `${String(i.InstanceId)} (${String(obj(i.State).Name)})`);
  if (expect.instanceId === null) {
    /* Coexistence before the host exists: there must be none (a host the operator did not name is not verified). */
    return { checks: [judge("EC2: no host yet (--instance-id none)", listed.items.length === 0, "no single-host instance for this environment", `${listed.items.length} single-host instance(s) exist: ${ids.join(", ")} -- name it with --instance-id`)], host: null };
  }
  const checks: HostCheck[] = [];
  const host = listed.items.find((i) => i.InstanceId === expect.instanceId) ?? null;
  checks.push(
    judge(
      "EC2: exactly one host",
      listed.items.length === 1 && host !== null,
      `${expect.instanceId}`,
      listed.items.length === 0 ? "no single-host instance for this environment" : host === null ? `the instance(s) ${ids.join(", ")} -- not ${expect.instanceId}` : `${listed.items.length} single-host instances: ${ids.join(", ")} -- a second host is a second serving writer (one ENI / EIP, one pool)`,
    ),
  );
  if (host === null) {
    checks.push(notEvaluated("EC2: the host's properties", `${expect.instanceId} is not in the evidence`));
    return { checks, host: null };
  }
  const id = String(host.InstanceId);
  const type = String(host.InstanceType);
  const tags = tagsOf(host);
  checks.push(judge("EC2: running", obj(host.State).Name === "running", "running", `state ${String(obj(host.State).Name)}`));
  checks.push(
    judge(
      "EC2: instance type",
      HOST_INSTANCE_TYPES.includes(type) && (expect.instanceType === null || type === expect.instanceType),
      type,
      HOST_INSTANCE_TYPES.includes(type) ? `${type}, expected ${expect.instanceType}` : `${type} is not one of the budget's types (${HOST_INSTANCE_TYPES.join(", ")})`,
    ),
  );
  checks.push(judge("EC2: the host's pool", tags.get("gs:pool") === expect.pool, `gs:pool ${expect.pool}`, `gs:pool ${String(tags.get("gs:pool"))}, the primary pool is ${expect.pool}`));
  /* Architecture: the type's, the instance's, the AMI's and the tag the deploy uses (linux/<arch> images). */
  const wanted = archOfType(type);
  const image = readHostEvidence(dir, HOST_EVIDENCE_FILES.image);
  const images = listOf(image, "Images");
  const tagArch = tags.get("gs:arch") === "amd64" ? "x86_64" : tags.get("gs:arch");
  if (!images.ok) checks.push(notEvaluated("EC2: architecture (type, instance, AMI)", images.why));
  else {
    const ami = images.items.find((i) => i.ImageId === host.ImageId);
    const problems = [
      wanted === null ? `no architecture for ${type}` : null,
      host.Architecture === wanted ? null : `the instance is ${String(host.Architecture)}, ${type} is ${wanted}`,
      ami === undefined ? `the AMI ${String(host.ImageId)} is not in the evidence` : ami.Architecture === wanted ? null : `the AMI ${String(host.ImageId)} is ${String(ami.Architecture)}`,
      tagArch === wanted ? null : `the gs:arch tag is ${String(tags.get("gs:arch"))}`,
    ].filter((p): p is string => p !== null);
    if (ami === undefined && problems.length === 1) checks.push(notEvaluated("EC2: architecture (type, instance, AMI)", problems[0]));
    else checks.push(judge("EC2: architecture (type, instance, AMI)", problems.length === 0, `${wanted} (${type}, ${String(host.ImageId)})`, problems.join("; ")));
  }
  /* CPU credits: standard (never billed for surplus). */
  const credits = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.creditSpecification), "InstanceCreditSpecifications");
  if (!credits.ok) checks.push(notEvaluated("EC2: CPU credits standard", credits.why));
  else {
    const spec = credits.items.find((c) => c.InstanceId === id);
    if (spec === undefined) checks.push(notEvaluated("EC2: CPU credits standard", `no credit specification for ${id} in the evidence`));
    else checks.push(judge("EC2: CPU credits standard", spec.CpuCredits === "standard", "standard", `CpuCredits ${String(spec.CpuCredits)} (unlimited bills surplus credits: it can cost more than the host)`));
  }
  /* IMDSv2 only, hop limit 2 (the container reaches the role; Caddy is refused by gs-imds-guard). */
  const md = obj(host.MetadataOptions);
  const imds = [
    md.HttpTokens === "required" ? null : `HttpTokens ${String(md.HttpTokens)} (IMDSv1 is allowed)`,
    md.HttpEndpoint === "enabled" ? null : `HttpEndpoint ${String(md.HttpEndpoint)}`,
    md.HttpPutResponseHopLimit === 2 ? null : `hop limit ${String(md.HttpPutResponseHopLimit)}`,
    md.HttpProtocolIpv6 === undefined || md.HttpProtocolIpv6 === "disabled" ? null : "IMDS over IPv6 (gs-imds-guard is IPv4)",
    md.InstanceMetadataTags === undefined || md.InstanceMetadataTags === "disabled" ? null : "instance tags in IMDS",
  ].filter((p): p is string => p !== null);
  checks.push(judge("EC2: IMDSv2 required, hop limit 2", Object.keys(md).length > 0 && imds.length === 0, "tokens required, hop limit 2, IPv4 only", Object.keys(md).length === 0 ? "no MetadataOptions in the evidence" : imds.join("; ")));
  /* The root volume (and every attached one) encrypted. */
  const volumes = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.volumes), "Volumes");
  const rootName = str(host.RootDeviceName);
  const rootMapping = arr(host.BlockDeviceMappings).map(obj).find((b) => b.DeviceName === rootName);
  const rootVolume = str(obj(rootMapping?.Ebs).VolumeId);
  if (!volumes.ok) checks.push(notEvaluated("EC2: encrypted root volume", volumes.why));
  else if (rootVolume === null) checks.push(fail("EC2: encrypted root volume", `no EBS root volume mapped at ${String(rootName)}`));
  else {
    const root = volumes.items.find((v) => v.VolumeId === rootVolume);
    const unencrypted = volumes.items.filter((v) => v.Encrypted !== true).map((v) => String(v.VolumeId));
    if (root === undefined) checks.push(notEvaluated("EC2: encrypted root volume", `${rootVolume} is not in the evidence`));
    else checks.push(judge("EC2: encrypted root volume", root.Encrypted === true && unencrypted.length === 0, `${rootVolume} encrypted (${volumes.items.length} volume(s), all encrypted)`, `unencrypted: ${unencrypted.join(", ")}`));
  }
  /* Termination protection (a replacement is a deliberate two-step change). */
  const termination = readHostEvidence(dir, HOST_EVIDENCE_FILES.terminationProtection);
  if (termination.kind !== "ok") checks.push(notEvaluated("EC2: termination protection", termination.why));
  else {
    const t = obj(termination.value);
    const value = obj(t.DisableApiTermination).Value;
    if (t.InstanceId !== undefined && t.InstanceId !== id) checks.push(fail("EC2: termination protection", `the evidence is ${String(t.InstanceId)}'s, not ${id}'s`));
    else if (typeof value !== "boolean") checks.push(notEvaluated("EC2: termination protection", "the answer has no DisableApiTermination value"));
    else checks.push(judge("EC2: termination protection", value, "on", "termination protection is OFF (turn it back on after a replacement)"));
  }
  checks.push(judge("EC2: no key pair", host.KeyName === undefined || host.KeyName === null || host.KeyName === "", "none (no SSH key exists)", `key pair ${String(host.KeyName)}`));
  checks.push(judge("EC2: detailed monitoring off", obj(host.Monitoring).State === "disabled", "disabled", `monitoring ${String(obj(host.Monitoring).State)} (billed per metric)`));
  const profile = str(obj(host.IamInstanceProfile).Arn);
  checks.push(judge("EC2: the host instance profile", profile === `arn:aws:iam::${expect.account}:instance-profile/${names.role}`, String(profile), `instance profile ${profile ?? "(none)"} (expected ${names.role} in ${expect.account})`));
  return { checks, host };
}

/* ------------------------------------------------------------------ */
/* Network: the ENI, the Elastic IP, the security group                 */
/* ------------------------------------------------------------------ */

interface Permission {
  readonly protocol: string;
  readonly from: number | null;
  readonly to: number | null;
  readonly cidrs: readonly string[];
  readonly cidrs6: readonly string[];
  readonly prefixLists: readonly string[];
  readonly groups: readonly string[];
}

const permissionsOf = (list: Json): Permission[] =>
  arr(list)
    .map(obj)
    .map((p) => ({
      protocol: String(p.IpProtocol),
      from: typeof p.FromPort === "number" ? p.FromPort : null,
      to: typeof p.ToPort === "number" ? p.ToPort : null,
      cidrs: arr(p.IpRanges).map((r) => String(obj(r).CidrIp)),
      cidrs6: arr(p.Ipv6Ranges).map((r) => String(obj(r).CidrIpv6)),
      prefixLists: arr(p.PrefixListIds).map((r) => String(obj(r).PrefixListId)),
      groups: arr(p.UserIdGroupPairs).map((r) => String(obj(r).GroupId)),
    }));

const covers = (p: Permission, port: number): boolean => p.protocol === "-1" || ((p.protocol === "tcp" || p.protocol === "6") && p.from !== null && p.to !== null && p.from <= port && port <= p.to);
const sourcesOf = (p: Permission): string => [...p.cidrs, ...p.cidrs6, ...p.prefixLists, ...p.groups].join(", ") || "(none)";

/** The host security group's ingress, rule by rule: 443 from CloudFront's list only; 80 for ACME only; 22 only in emergency mode; never 8917; nothing else. */
export function judgeHostIngress(permissions: readonly Permission[], expect: { readonly cloudFrontPrefixList: string | null; readonly emergencySsh: boolean; readonly serverPort: number }): HostCheck[] {
  const checks: HostCheck[] = [];
  const port8917 = permissions.filter((p) => covers(p, expect.serverPort));
  checks.push(judge(`security group: no public ${expect.serverPort}`, port8917.length === 0, `no rule reaches ${expect.serverPort} (the server is on the host's loopback)`, `${expect.serverPort} is open from ${port8917.map(sourcesOf).join("; ")}`));
  const ssh = permissions.filter((p) => covers(p, 22));
  const sshCidrs = ssh.flatMap((p) => [...p.cidrs, ...p.cidrs6, ...p.prefixLists, ...p.groups]);
  if (!expect.emergencySsh) checks.push(judge("security group: no SSH", ssh.length === 0, "no rule reaches 22", `22 is open from ${sshCidrs.join(", ")} (only --emergency-ssh accepts it, and only as at most two /32 addresses)`));
  else {
    const exact = ssh.every((p) => p.protocol === "tcp" && p.from === 22 && p.to === 22 && p.cidrs6.length === 0 && p.prefixLists.length === 0 && p.groups.length === 0);
    const ok = exact && sshCidrs.length <= 2 && sshCidrs.every((c) => /^([0-9]{1,3}\.){3}[0-9]{1,3}\/32$/.test(c));
    checks.push(judge("security group: emergency SSH only", ok, ssh.length === 0 ? "no rule reaches 22" : `22 from ${sshCidrs.join(", ")} (EMERGENCY: remove after use)`, `22 from ${sshCidrs.join(", ")} -- emergency SSH is at most two /32 addresses on exactly port 22`));
  }
  const https = permissions.filter((p) => covers(p, 443));
  if (expect.cloudFrontPrefixList === null) checks.push(notEvaluated("security group: 443 from CloudFront only", "CloudFront's origin-facing prefix list id is not in the evidence"));
  else {
    const ok = https.length === 1 && https[0].protocol === "tcp" && https[0].from === 443 && https[0].to === 443 && https[0].prefixLists.length === 1 && https[0].prefixLists[0] === expect.cloudFrontPrefixList && https[0].cidrs.length === 0 && https[0].cidrs6.length === 0 && https[0].groups.length === 0;
    checks.push(judge("security group: 443 from CloudFront only", ok, `tcp 443 from ${expect.cloudFrontPrefixList} only`, https.length === 0 ? "no rule admits 443: CloudFront cannot reach the origin" : `443 is reachable from ${https.map(sourcesOf).join("; ")}`));
  }
  const http = permissions.filter((p) => covers(p, 80));
  checks.push(judge("security group: 80 for ACME only", http.length <= 1 && http.every((p) => p.protocol === "tcp" && p.from === 80 && p.to === 80), http.length === 0 ? "no 80 (no ACME renewal path)" : "tcp 80 exactly (Caddy serves the HTTP-01 challenge and 404)", `80 is opened by a wider rule: ${http.map((p) => `${p.protocol} ${String(p.from)}-${String(p.to)}`).join("; ")}`));
  const other = permissions.filter((p) => !covers(p, 443) && !covers(p, 80) && !covers(p, 22) && !covers(p, expect.serverPort));
  const wide = permissions.filter((p) => p.protocol === "-1" || (p.from !== null && p.to !== null && p.to - p.from > 0 && !(p.from === 22 && p.to === 22)));
  checks.push(judge("security group: no other ingress", other.length === 0 && wide.length === 0, "443, 80 (and emergency 22) only", [...other, ...wide].map((p) => `${p.protocol} ${String(p.from)}-${String(p.to)} from ${sourcesOf(p)}`).join("; ")));
  return checks;
}

export function checkHostNetwork(dir: string, expect: HostExpect, host: Record<string, Json>): HostCheck[] {
  const names = hostNames(expect.environment);
  const checks: HostCheck[] = [];
  const id = String(host.InstanceId);
  /* The ENI: one, the primary, carrying exactly the host security group. */
  const interfaces = arr(host.NetworkInterfaces).map(obj);
  const eni = interfaces.length === 1 && obj(interfaces[0].Attachment).DeviceIndex === 0 ? str(interfaces[0].NetworkInterfaceId) : null;
  const groups = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.securityGroups), "SecurityGroups");
  const sg = groups.ok ? groups.items.find((g) => g.GroupName === names.securityGroup && (host.VpcId === undefined || g.VpcId === host.VpcId)) : undefined;
  const eniGroups = interfaces.length === 1 ? arr(interfaces[0].Groups).map((g) => String(obj(g).GroupId)) : [];
  checks.push(judge("network: one ENI", eni !== null, `${eni} (device 0)`, `${interfaces.length} network interface(s): the host has exactly its one ENI (it survives replacement with the EIP)`));
  if (!groups.ok) checks.push(notEvaluated("network: the ENI carries the host security group only", groups.why));
  else if (sg === undefined) checks.push(fail("network: the ENI carries the host security group only", `no security group ${names.securityGroup} in the host's VPC`));
  else checks.push(judge("network: the ENI carries the host security group only", eniGroups.length === 1 && eniGroups[0] === sg.GroupId, `${String(sg.GroupId)} (${names.securityGroup})`, `the ENI carries [${eniGroups.join(", ")}], expected [${String(sg.GroupId)}]`));
  const eniRead = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.networkInterfaces), "NetworkInterfaces");
  if (!eniRead.ok) checks.push(notEvaluated("network: the expected ENI", eniRead.why));
  else {
    const described = eniRead.items.find((n) => n.NetworkInterfaceId === eni);
    const problems = described === undefined ? [`${String(eni)} is not in the evidence`] : [tagsOf(described).get("Name") === names.host ? null : `Name tag ${String(tagsOf(described).get("Name"))}`, described.SourceDestCheck === true ? null : "source/destination check off", obj(described.Attachment).InstanceId === id ? null : `attached to ${String(obj(described.Attachment).InstanceId)}`].filter((p): p is string => p !== null);
    if (described === undefined) checks.push(notEvaluated("network: the expected ENI", problems[0]));
    else checks.push(judge("network: the expected ENI", problems.length === 0, `${eni}: ${names.host}, attached to ${id}`, problems.join("; ")));
  }
  /* The Elastic IP: exactly one host EIP, on the host's ENI, and it IS the host's public address. */
  const addresses = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.addresses), "Addresses");
  const outputs = readHostEvidence(dir, HOST_EVIDENCE_FILES.terraformOutputs);
  const tfIp = outputs.kind === "ok" ? str(obj(obj(outputs.value).public_ip).value) : null;
  if (!addresses.ok) checks.push(notEvaluated("network: exactly one host EIP", addresses.why));
  else {
    const mine = addresses.items.filter((a) => tagsOf(a).get("gs:environment") === expect.environment && tagsOf(a).get("gs:component") === "single-host");
    if (mine.length !== 1) checks.push(fail("network: exactly one host EIP", `${mine.length} single-host Elastic IP(s) for ${expect.environment}: ${mine.map((a) => String(a.PublicIp)).join(", ") || "none"}`));
    else {
      const eip = mine[0];
      const problems = [
        eip.NetworkInterfaceId === eni ? null : `associated with ${String(eip.NetworkInterfaceId ?? "nothing")}, not the host's ENI ${String(eni)}`,
        eip.PublicIp === host.PublicIpAddress ? null : `the host's public address is ${String(host.PublicIpAddress)}, the EIP is ${String(eip.PublicIp)}`,
        tfIp === null || tfIp === eip.PublicIp ? null : `Terraform's public_ip output is ${tfIp}`,
      ].filter((p): p is string => p !== null);
      checks.push(judge("network: exactly one host EIP", problems.length === 0, `${String(eip.PublicIp)} on ${String(eni)}`, problems.join("; ")));
    }
  }
  /* The security group's rules. */
  if (groups.ok && sg !== undefined) {
    const pl = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.prefixList), "PrefixLists");
    const cloudFront = pl.ok ? str(pl.items.find((p) => p.PrefixListName === CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST)?.PrefixListId) : null;
    checks.push(...judgeHostIngress(permissionsOf(sg.IpPermissions), { cloudFrontPrefixList: cloudFront, emergencySsh: expect.emergencySsh, serverPort: 8917 }));
    const egress = permissionsOf(sg.IpPermissionsEgress);
    const allowedPorts = new Set([443, ...expect.junoEgressPorts]);
    const badEgress = egress.filter((p) => p.protocol !== "tcp" || p.from === null || p.from !== p.to || !allowedPorts.has(p.from));
    checks.push(judge("security group: egress", badEgress.length === 0 && egress.length > 0, `tcp ${[...allowedPorts].join(", ")} only`, egress.length === 0 ? "no egress at all (the host cannot reach DynamoDB, KMS, SSM or Juno)" : `unexpected egress: ${badEgress.map((p) => `${p.protocol} ${String(p.from)}-${String(p.to)}`).join("; ")}`));
  } else if (groups.ok) checks.push(fail("security group: rules", `${names.securityGroup} is not in the evidence`));
  return checks;
}

/* ------------------------------------------------------------------ */
/* IAM: the host role, limited to the configured authorities            */
/* ------------------------------------------------------------------ */

const GAME_TABLE_ACTIONS = new Set(["dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:ConditionCheckItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]);
const GAME_WRITE_ACTIONS = new Set(["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]);
const IDENTITY_ACTIONS = new Set(["dynamodb:GetItem", "dynamodb:Scan", "dynamodb:ConditionCheckItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]);
const LEDGER_ACTIONS = new Set(["dynamodb:GetItem", "dynamodb:Query", "dynamodb:ConditionCheckItem", "dynamodb:PutItem"]);
const SSM_AGENT_UNSCOPED = new Set([
  "ssmmessages:CreateControlChannel",
  "ssmmessages:CreateDataChannel",
  "ssmmessages:OpenControlChannel",
  "ssmmessages:OpenDataChannel",
  "ec2messages:AcknowledgeMessage",
  "ec2messages:DeleteMessage",
  "ec2messages:FailMessage",
  "ec2messages:GetEndpoint",
  "ec2messages:GetMessages",
  "ec2messages:SendReply",
]);

const listStrings = (value: Json): string[] => (typeof value === "string" ? [value] : arr(value).map(String));

/** The leading-key condition of a statement (`ForAllValues:StringNotEquals` / `dynamodb:LeadingKeys`). */
const leadingKeysExcluded = (statement: Record<string, Json>): string[] => listStrings(obj(obj(statement.Condition)["ForAllValues:StringNotEquals"])["dynamodb:LeadingKeys"]);

/**
 * The host role's one inline policy, statement by statement: every action is one the single-host module grants, on exactly
 * the authorities the runtime documents name -- the game table(s), the identity table, the ledger, this pool's runtime
 * document (+ the Juno document), the escrow configuration's KMS keys, the ONE repository and log group. Anything else (an
 * iam / sts / secretsmanager / kms:CreateGrant action, a wildcard action, a Deny-less NotAction, another table or key) FAILS.
 */
export function judgeHostPolicy(doc: Record<string, Json>, expect: HostExpect): HostCheck[] {
  const names = hostNames(expect.environment);
  const a = expect.authorities;
  const ecrRepository = `arn:aws:ecr:${expect.region}:${expect.account}:repository/${names.ecrRepository}`;
  const logStreams = `arn:aws:logs:${expect.region}:${expect.account}:log-group:${names.logGroup}:log-stream:*`;
  const instances = `arn:aws:ec2:${expect.region}:${expect.account}:instance/*`;
  const ssmParameters = new Set([a.runtimeParameterArn, ...(a.junoParameterArn === null ? [] : [a.junoParameterArn])]);
  const problems: string[] = [];
  const kmsSeen = new Set<string>();
  const ssmSeen = new Set<string>();
  for (const raw of Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement]) {
    const s = obj(raw);
    const sid = String(s.Sid ?? "(no Sid)");
    if (s.NotAction !== undefined || s.NotResource !== undefined || s.NotPrincipal !== undefined) {
      problems.push(`${sid}: NotAction / NotResource (an open-ended grant)`);
      continue;
    }
    if (s.Effect === "Deny") continue; // a Deny can only narrow
    if (s.Effect !== "Allow") {
      problems.push(`${sid}: effect ${String(s.Effect)}`);
      continue;
    }
    const actions = listStrings(s.Action);
    const resources = listStrings(s.Resource);
    const condition = obj(s.Condition);
    for (const action of actions) {
      const only = (allowed: readonly string[]) => {
        const outside = resources.filter((r) => !allowed.includes(r));
        if (outside.length > 0 || resources.length === 0) problems.push(`${sid}: ${action} on ${resources.join(", ") || "(no resource)"} -- outside [${allowed.join(", ")}]`);
      };
      if (action.includes("*")) problems.push(`${sid}: the wildcard action ${action}`);
      else if (GAME_TABLE_ACTIONS.has(action) && resources.every((r) => a.gameTableArns.includes(r)) && resources.length > 0) {
        if (GAME_WRITE_ACTIONS.has(action) && !leadingKeysExcluded(s).includes("SYSTEM")) problems.push(`${sid}: ${action} on the game table without the SYSTEM/* exclusion (the routing and generation markers are the operator's)`);
      } else if (IDENTITY_ACTIONS.has(action) && resources.length > 0 && resources.every((r) => r === a.identityTableArn)) {
        /* the identity writer's reads and writes */
      } else if (LEDGER_ACTIONS.has(action) && resources.length > 0 && resources.every((r) => r === a.ledgerTableArn)) {
        if (action === "dynamodb:PutItem" && !(leadingKeysExcluded(s).includes("APPGEN") && leadingKeysExcluded(s).includes("APPGEN#HISTORY"))) problems.push(`${sid}: ledger PutItem without the APPGEN / APPGEN#HISTORY exclusion`);
      } else if (action.startsWith("dynamodb:")) problems.push(`${sid}: ${action} on ${resources.join(", ")} -- not the runtime documents' tables with that action`);
      else if (action === "ssm:GetParameter") {
        only([...ssmParameters]);
        for (const r of resources) ssmSeen.add(r);
      } else if (action === "kms:GetPublicKey" || action === "kms:Sign") {
        if (a.kmsKeyArns === null) problems.push(`${sid}: ${action} granted, but the runtime document has no escrow (no signing key is configured)`);
        else only(a.kmsKeyArns);
        for (const r of resources) kmsSeen.add(r);
        if (action === "kms:Sign") {
          const eq = obj(condition.StringEquals);
          if (eq["kms:SigningAlgorithm"] !== "ECDSA_SHA_256" || eq["kms:MessageType"] !== "DIGEST") problems.push(`${sid}: kms:Sign without the ECDSA_SHA_256 / DIGEST condition`);
        }
      } else if (action === "ecr:GetAuthorizationToken") only(["*"]);
      else if (action === "ecr:BatchCheckLayerAvailability" || action === "ecr:GetDownloadUrlForLayer" || action === "ecr:BatchGetImage") only([ecrRepository]);
      else if (action === "logs:CreateLogStream" || action === "logs:PutLogEvents") only([logStreams]);
      else if (action === "cloudwatch:PutMetricData") {
        only(["*"]);
        if (obj(condition.StringEquals)["cloudwatch:namespace"] !== HOST_METRIC_NAMESPACE) problems.push(`${sid}: PutMetricData beyond the ${HOST_METRIC_NAMESPACE} namespace`);
      } else if (action === "ssm:UpdateInstanceInformation" || action === "ssm:ListInstanceAssociations") only([instances]);
      else if (SSM_AGENT_UNSCOPED.has(action)) only(["*"]);
      else problems.push(`${sid}: ${action} is not an action the single-host module grants`);
    }
  }
  const checks: HostCheck[] = [judge("IAM: the host policy is limited to the configured authorities", problems.length === 0, "game / identity / ledger tables, this pool's documents, the configured keys, one repository, one log group", problems.slice(0, 8).join("; ") + (problems.length > 8 ? `; ... (${problems.length} in all)` : ""))];
  /* The keys the role may sign with ARE the escrow configuration's -- no more, no fewer (a stale key after a rotation, or
     a missing one, is a wrong allow-list). */
  if (a.kmsKeyArns === null) checks.push(judge("IAM: KMS keys = the runtime Juno configuration's", kmsSeen.size === 0, "no escrow, no key", `keys granted without escrow: ${[...kmsSeen].join(", ")}`));
  else {
    const want = [...a.kmsKeyArns].sort();
    const got = [...kmsSeen].sort();
    checks.push(judge("IAM: KMS keys = the runtime Juno configuration's", JSON.stringify(want) === JSON.stringify(got), `${want.length} key(s): the configuration's relayer, settlement and admission keys`, `the role names [${got.join(", ")}], the configuration names [${want.join(", ")}]`));
  }
  const wantSsm = [...ssmParameters].sort();
  checks.push(judge("IAM: SSM documents = this pool's", JSON.stringify([...ssmSeen].sort()) === JSON.stringify(wantSsm), wantSsm.join(", "), `the role reads [${[...ssmSeen].sort().join(", ")}], expected [${wantSsm.join(", ")}]`));
  return checks;
}

export function checkHostIam(dir: string, expect: HostExpect): HostCheck[] {
  const names = hostNames(expect.environment);
  const checks: HostCheck[] = [];
  const roleArn = `arn:aws:iam::${expect.account}:role/${names.role}`;
  const profile = readHostEvidence(dir, HOST_EVIDENCE_FILES.instanceProfile);
  if (profile.kind !== "ok") checks.push(notEvaluated("IAM: the instance profile holds the host role", profile.why));
  else {
    const roles = arr(obj(obj(profile.value).InstanceProfile).Roles).map(obj);
    checks.push(judge("IAM: the instance profile holds the host role", roles.length === 1 && roles[0].Arn === roleArn, roleArn, `roles [${roles.map((r) => String(r.Arn)).join(", ")}], expected [${roleArn}]`));
  }
  const role = readHostEvidence(dir, HOST_EVIDENCE_FILES.role);
  if (role.kind !== "ok") checks.push(notEvaluated("IAM: the host role", role.why));
  else {
    const r = obj(obj(role.value).Role);
    const trust = policyDocument(r.AssumeRolePolicyDocument);
    const statements = arr(trust?.Statement).map(obj);
    const ec2Only =
      statements.length === 1 &&
      statements[0].Effect === "Allow" &&
      listStrings(statements[0].Action).join(",") === "sts:AssumeRole" &&
      JSON.stringify(obj(statements[0].Principal)) === JSON.stringify({ Service: "ec2.amazonaws.com" }) &&
      obj(obj(statements[0].Condition).StringEquals)["aws:SourceAccount"] === expect.account;
    checks.push(judge("IAM: the host role", r.Arn === roleArn && ec2Only, `${roleArn}, assumable by EC2 of ${expect.account} only`, r.Arn !== roleArn ? `role ${String(r.Arn)}` : `its trust policy is not EC2-of-this-account only: ${JSON.stringify(trust).slice(0, 200)}`));
  }
  const attached = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.roleAttachedPolicies), "AttachedPolicies");
  if (!attached.ok) checks.push(notEvaluated("IAM: no managed policy", attached.why));
  else checks.push(judge("IAM: no managed policy", attached.items.length === 0, "none attached (AmazonSSMManagedInstanceCore would read every parameter)", `attached: ${attached.items.map((p) => String(p.PolicyArn)).join(", ")}`));
  const inline = readHostEvidence(dir, HOST_EVIDENCE_FILES.roleInlinePolicies);
  const inlineNames = inline.kind === "ok" && isArr(obj(inline.value).PolicyNames) ? arr(obj(inline.value).PolicyNames).map(String) : null;
  if (inlineNames === null) checks.push(notEvaluated("IAM: one inline policy", inline.kind === "ok" ? "the answer has no PolicyNames list" : inline.why));
  else checks.push(judge("IAM: one inline policy", inlineNames.length === 1 && inlineNames[0] === HOST_POLICY_NAME, HOST_POLICY_NAME, `inline policies [${inlineNames.join(", ")}]`));
  const policy = readHostEvidence(dir, HOST_EVIDENCE_FILES.rolePolicy);
  const doc = policy.kind === "ok" ? policyDocument(obj(policy.value).PolicyDocument) : null;
  if (policy.kind !== "ok" || doc === null) {
    const why = policy.kind !== "ok" ? policy.why : "the policy document could not be read";
    checks.push(notEvaluated("IAM: the host policy is limited to the configured authorities", why), notEvaluated("IAM: KMS keys = the runtime Juno configuration's", why), notEvaluated("IAM: SSM documents = this pool's", why));
  } else if (obj(policy.value).RoleName !== undefined && obj(policy.value).RoleName !== names.role) checks.push(fail("IAM: the host policy", `the evidence is ${String(obj(policy.value).RoleName)}'s policy`));
  else checks.push(...judgeHostPolicy(doc, expect));
  return checks;
}

/* ------------------------------------------------------------------ */
/* The host itself: SSM and gs-health                                   */
/* ------------------------------------------------------------------ */

export interface HostHealthLine {
  readonly server: string;
  readonly caddy: string;
  readonly build: string;
  readonly digest: string;
  readonly running_digest: string;
  readonly hold: string;
  readonly healthz: string;
  readonly readyz: string;
  readonly origin_tls_readyz: string;
  readonly static_credentials: string;
  readonly origin_hostname: string;
}

/** The last JSON object line of the host command's output (gs-health prints exactly one). */
export function parseHostHealth(stdout: Json): HostHealthLine | null {
  if (typeof stdout !== "string") return null;
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{") && l.endsWith("}"));
  if (lines.length === 0) return null;
  try {
    const o = obj(JSON.parse(lines[lines.length - 1]));
    const field = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
    return { server: field("server"), caddy: field("caddy"), build: field("build"), digest: field("digest"), running_digest: field("running_digest"), hold: field("hold"), healthz: field("healthz"), readyz: field("readyz"), origin_tls_readyz: field("origin_tls_readyz"), static_credentials: field("static_credentials"), origin_hostname: field("origin_hostname") };
  } catch {
    return null;
  }
}

export function checkHostRuntime(dir: string, expect: HostExpect): HostCheck[] {
  const id = expect.instanceId as string;
  const checks: HostCheck[] = [];
  const ssm = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.ssmInstance), "InstanceInformationList");
  if (!ssm.ok) checks.push(notEvaluated("host: SSM managed and online", ssm.why));
  else {
    const me = ssm.items.filter((i) => i.InstanceId === id);
    checks.push(judge("host: SSM managed and online", me.length === 1 && me[0].PingStatus === "Online", `${id} Online`, me.length === 0 ? `${id} is not an SSM managed instance (the operator path is Run Command; there is no SSH)` : `PingStatus ${String(me[0].PingStatus)}`));
  }
  const NAMES = ["host: gs-health", "host: release digest", "host: build id", "host: HOLD", "host: gs-server / gs-caddy (systemd)", "host: no static credential", "host: its origin is --origin-hostname"] as const;
  const invocation = readHostEvidence(dir, HOST_EVIDENCE_FILES.hostHealth);
  if (invocation.kind !== "ok") {
    for (const name of NAMES) checks.push(notEvaluated(name, `${invocation.why} (capture with --host-status: SSM Run Command of the fixed read-only /opt/gs/bin/gs-health)`));
    return checks;
  }
  const inv = obj(invocation.value);
  const line = parseHostHealth(inv.StandardOutputContent);
  const at = evidenceTime(inv.ExecutionEndDateTime);
  const invocationProblems = [inv.InstanceId === id ? null : `the invocation ran on ${String(inv.InstanceId)}, not ${id}`, inv.DocumentName === undefined || inv.DocumentName === "AWS-RunShellScript" ? null : `document ${String(inv.DocumentName)}`].filter((p): p is string => p !== null);
  if (invocationProblems.length > 0) {
    for (const name of NAMES) checks.push(fail(name, invocationProblems.join("; ")));
    return checks;
  }
  if (line === null) {
    for (const name of NAMES) checks.push(notEvaluated(name, `the host command ended ${String(inv.Status)} with no gs-health line`));
    return checks;
  }
  checks.push(freshness("host: gs-health fresh", at, expect));
  checks.push(judge("host: gs-health", line.readyz === "200" && line.healthz === "200" && line.origin_tls_readyz === "200", "healthz 200, readyz 200, origin TLS readyz 200", `healthz ${line.healthz}, readyz ${line.readyz}, origin TLS readyz ${line.origin_tls_readyz} (gs-health exits non-zero until ready)`));
  const DIGEST = /^sha256:[0-9a-f]{64}$/;
  if (!DIGEST.test(line.digest)) checks.push(fail("host: release digest", `the release file names ${line.digest || "no digest"}: nothing was deployed (gs-deploy writes it)`));
  else if (line.running_digest !== line.digest) checks.push(fail("host: release digest", `the running container is ${line.running_digest || "none"}, the release file says ${line.digest} (a deploy did not finish, or a container was started by hand)`));
  else if (expect.expectDigest === null) checks.push(notEvaluated("host: release digest", `${line.digest} running -- name the reviewed release with --expect-digest to evaluate it`));
  else checks.push(judge("host: release digest", line.digest === expect.expectDigest, `${line.digest} (release = running = expected)`, `${line.digest} runs, the reviewed release is ${expect.expectDigest}`));
  if (expect.expectBuild === null) checks.push(notEvaluated("host: build id", `${line.build || "none"} -- name the reviewed build with --expect-build to evaluate it`));
  else checks.push(judge("host: build id", line.build === expect.expectBuild, line.build, `the host runs build ${line.build || "none"}, expected ${expect.expectBuild}`));
  checks.push(judge("host: HOLD", line.hold === "none", "none", `HELD (${line.hold}): the server waits for the operator after a loss (exit 3) or a role change (exit 5); only gs-deploy / gs-rollback clears it`));
  checks.push(judge("host: gs-server / gs-caddy (systemd)", line.server === "active" && line.caddy === "active", "both active", `gs-server ${line.server || "?"}, gs-caddy ${line.caddy || "?"}`));
  /* The chain CloudFront -> host: the /gs* origin is --origin-hostname (the edge check), and THIS host's Caddy serves
     exactly that name (its certificate and origin_tls_readyz are for it) -- not merely a name the operator typed. */
  checks.push(judge("host: its origin is --origin-hostname", line.origin_hostname !== "" && line.origin_hostname === expect.originHostname, `${line.origin_hostname} (Caddy's certificate name; origin TLS readyz ${line.origin_tls_readyz})`, line.origin_hostname === "" ? "gs-health did not report it (an older host script): redeploy the host files" : `the host serves ${line.origin_hostname}, --origin-hostname is ${String(expect.originHostname)}`));
  checks.push(judge("host: no static credential", line.static_credentials === "none", "none on the host (the instance role is the only credential source)", line.static_credentials === "" ? "gs-health did not report it (an older host script): redeploy the host files" : `a static AWS credential is PRESENT (${line.static_credentials}) -- remove it; the runtime refuses it anyway`));
  return checks;
}

/* ------------------------------------------------------------------ */
/* CloudFront: the /gs* origin of this migration state                  */
/* ------------------------------------------------------------------ */

export function checkHostEdge(dir: string, expect: HostExpect): HostCheck[] {
  const names = hostNames(expect.environment);
  const dist = readHostEvidence(dir, HOST_EVIDENCE_FILES.distributionConfig);
  const orp = readHostEvidence(dir, HOST_EVIDENCE_FILES.originRequestPolicy);
  const NAMES = ["edge: /gs* origin", "edge: /gs* request policy preserved", "edge: default frontend origin unchanged"];
  if (dist.kind !== "ok" || orp.kind !== "ok") {
    const why = dist.kind !== "ok" ? dist.why : (orp as { why: string }).why;
    return [...NAMES, "edge: /gs* query strings, cookies, Origin and WebSocket headers"].map((n) => notEvaluated(n, why));
  }
  const config = obj(obj(dist.value).DistributionConfig);
  const behaviors = arr(obj(config.CacheBehaviors).Items).map(obj);
  const origins = arr(obj(config.Origins).Items).map(obj);
  const gs = behaviors.filter((b) => b.PathPattern === "/gs*");
  const checks: HostCheck[] = [];
  if (gs.length !== 1) checks.push(fail("edge: /gs* origin", `${gs.length} behaviours with the path pattern /gs*`));
  else {
    const origin = origins.find((o) => o.Id === gs[0].TargetOriginId);
    const domain = str(origin?.DomainName);
    checks.push(judge("edge: /gs* origin", gs[0].TargetOriginId === "gs-alb" && domain === expect.gsOrigin, `${domain} (origin gs-alb)`, `/gs* reaches origin ${String(gs[0].TargetOriginId)} = ${String(domain)}; this migration state expects ${expect.gsOrigin}`));
  }
  /* L5-8's edge judgement, unchanged (first match, uncached, methods, https both ways, ALL query strings, cookies, headers). */
  const edge = checkEdgeEvidence(dist.value, orp.value);
  for (const c of edge) checks.push({ name: c.name.replace(/^edge: /, "edge (L5-8): "), status: c.status, detail: c.detail });
  const policy = obj(obj(orp.value).OriginRequestPolicy);
  const policyName = obj(policy.OriginRequestPolicyConfig).Name;
  checks.push(judge("edge: /gs* request policy preserved", gs.length === 1 && gs[0].OriginRequestPolicyId === policy.Id && policyName === names.originRequestPolicy, `${String(policy.Id)} (${names.originRequestPolicy})`, `the /gs* behaviour uses ${String(gs[0]?.OriginRequestPolicyId)}, the policy is ${String(policy.Id)} named ${String(policyName)} (expected ${names.originRequestPolicy})`));
  const def = obj(config.DefaultCacheBehavior);
  const site = origins.find((o) => o.Id === def.TargetOriginId);
  const siteDomain = str(site?.DomainName);
  if (def.TargetOriginId !== "site" || siteDomain === null || siteDomain === expect.gsOrigin || siteDomain === expect.originHostname) checks.push(fail("edge: default frontend origin unchanged", `the default behaviour reaches ${String(def.TargetOriginId)} = ${String(siteDomain)} (the frontend's origin is \`site\`, never the game server)`));
  else if (expect.siteOrigin === null) checks.push(notEvaluated("edge: default frontend origin unchanged", `site = ${siteDomain} -- name it with --site-origin to evaluate it`));
  else checks.push(judge("edge: default frontend origin unchanged", siteDomain === expect.siteOrigin, `site = ${siteDomain}`, `site = ${siteDomain}, expected ${expect.siteOrigin}`));
  return checks;
}

/* ------------------------------------------------------------------ */
/* Observability: one log group, exactly five alarms, the budget        */
/* ------------------------------------------------------------------ */

interface AlarmSpec {
  readonly name: string;
  readonly namespace: string;
  readonly metric: string;
  readonly dimension: readonly [string, string];
  readonly comparison: string;
  readonly threshold: number;
  readonly missing: string;
}

export function hostAlarmSpecs(environment: string, instanceId: string): AlarmSpec[] {
  const n = hostNames(environment).alarms;
  return [
    { name: n.health, namespace: APP_METRIC_NAMESPACE, metric: "HostHealthProblems", dimension: ["Environment", environment], comparison: "GreaterThanOrEqualToThreshold", threshold: 1, missing: "breaching" },
    { name: n.critical, namespace: APP_METRIC_NAMESPACE, metric: "HostCriticalEvents", dimension: ["Environment", environment], comparison: "GreaterThanOrEqualToThreshold", threshold: 1, missing: "notBreaching" },
    { name: n.statusCheck, namespace: "AWS/EC2", metric: "StatusCheckFailed", dimension: ["InstanceId", instanceId], comparison: "GreaterThanOrEqualToThreshold", threshold: 1, missing: "notBreaching" },
    { name: n.pressure, namespace: HOST_METRIC_NAMESPACE, metric: "HostPressure", dimension: ["Environment", environment], comparison: "GreaterThanOrEqualToThreshold", threshold: 1, missing: "notBreaching" },
    { name: n.cpuCredits, namespace: "AWS/EC2", metric: "CPUCreditBalance", dimension: ["InstanceId", instanceId], comparison: "LessThanThreshold", threshold: 30, missing: "notBreaching" },
  ];
}

/**
 * This environment's alarms. A name prefix alone over-matches (`gs-staging-` is also `gs-staging-eu-`'s), so an alarm is
 * this environment's when its name is one this environment's stacks make -- the five host alarms, or L6-5B's contract for
 * any pool the ECS era may have had (alarm, `-notify` composite, flip-window suppressor) -- or when it carries an
 * `Environment` dimension naming this environment. Anything else under the prefix is another environment's.
 */
export function ecsEraAlarmNames(environment: string, pools: readonly string[]): ReadonlySet<string> {
  const names = new Set<string>();
  const sorted = [...new Set(pools)].sort();
  for (const e of expectedAlarms({ environment, pools: sorted, primaryPool: sorted[0] ?? "p1", escrow: true, services: true })) {
    names.add(e.name);
    names.add(`${e.name}-notify`);
  }
  for (const pool of sorted) names.add(suppressorName(environment, pool));
  return names;
}

function environmentAlarms(read: HostRead, environment: string, pools: readonly string[]): { readonly ok: true; readonly metric: Array<Record<string, Json>>; readonly composite: Array<Record<string, Json>> } | { readonly ok: false; readonly why: string } {
  const metric = listOf(read, "MetricAlarms");
  const composite = listOf(read, "CompositeAlarms");
  if (!metric.ok) return metric;
  if (!composite.ok) return composite;
  const host = new Set(Object.values(hostNames(environment).alarms));
  const legacy = ecsEraAlarmNames(environment, pools);
  const ours = (a: Record<string, Json>) => {
    const name = String(a.AlarmName);
    const env = arr(a.Dimensions).map(obj).find((d) => d.Name === "Environment");
    if (env !== undefined) return env.Value === environment;
    return host.has(name) || legacy.has(name);
  };
  return { ok: true, metric: metric.items.filter(ours), composite: composite.items.filter(ours) };
}

export function checkHostObservability(dir: string, expect: HostExpect): HostCheck[] {
  const names = hostNames(expect.environment);
  const checks: HostCheck[] = [];
  /* The log group. */
  const groups = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.logGroups), "logGroups");
  if (expect.instanceId === null) checks.push(skip("observability: one host log group", "no host yet (--instance-id none): the host's log group is created with it (step D 9)"));
  else if (!groups.ok) checks.push(notEvaluated("observability: one host log group", groups.why));
  else {
    const mine = groups.items.filter((g) => String(g.logGroupName).startsWith(names.logGroupPrefix));
    const host = mine.find((g) => g.logGroupName === names.logGroup);
    const others = mine.filter((g) => g !== host).map((g) => String(g.logGroupName));
    const retention = typeof host?.retentionInDays === "number" ? host.retentionInDays : null;
    const problems = [
      host === undefined ? `${names.logGroup} does not exist` : null,
      host !== undefined && (retention === null || retention > 90) ? `retention ${retention === null ? "never expires" : `${retention} days`} (the budget caps it at 90)` : null,
      host !== undefined && host.logGroupClass !== undefined && host.logGroupClass !== "STANDARD" ? `class ${String(host.logGroupClass)} (EMF extraction needs STANDARD)` : null,
      expect.topology === "single-host" && others.length > 0 ? `the ECS era's log group(s) remain: ${others.join(", ")} (export them, then remove them -- step I)` : null,
    ].filter((p): p is string => p !== null);
    checks.push(judge("observability: one host log group", problems.length === 0, `${names.logGroup}, ${retention} days${others.length > 0 ? `; the ECS era's ${others.join(", ")} still exist (coexistence)` : ""}`, problems.join("; ")));
  }
  /* Exactly five host alarms -- each the module's, on THIS host -- and, in the final state, nothing else. */
  const alarms = environmentAlarms(readHostEvidence(dir, HOST_EVIDENCE_FILES.alarms), expect.environment, expect.legacyPools);
  if (!alarms.ok) checks.push(notEvaluated("observability: exactly five host alarms", alarms.why));
  else if (expect.instanceId === null) checks.push(skip("observability: exactly five host alarms", "no host yet (--instance-id none)"));
  else {
    const specs = hostAlarmSpecs(expect.environment, expect.instanceId);
    const problems: string[] = [];
    const actionSets = new Set<string>();
    for (const spec of specs) {
      const found = alarms.metric.filter((a) => a.AlarmName === spec.name);
      if (found.length !== 1) {
        problems.push(`${spec.name}: ${found.length === 0 ? "missing" : "duplicated"}`);
        continue;
      }
      const a = found[0];
      const dims = arr(a.Dimensions).map(obj);
      const wrong = [
        a.Namespace === spec.namespace && a.MetricName === spec.metric ? null : `${String(a.Namespace)}/${String(a.MetricName)}`,
        dims.length === 1 && dims[0].Name === spec.dimension[0] && dims[0].Value === spec.dimension[1] ? null : `dimensions ${dims.map((d) => `${String(d.Name)}=${String(d.Value)}`).join(",")} (expected ${spec.dimension.join("=")}${spec.dimension[0] === "InstanceId" ? ": a stale alarm watches a replaced host" : ""})`,
        a.ComparisonOperator === spec.comparison && a.Threshold === spec.threshold ? null : `${String(a.ComparisonOperator)} ${String(a.Threshold)}`,
        a.TreatMissingData === spec.missing ? null : `missing data ${String(a.TreatMissingData)} (expected ${spec.missing}${spec.missing === "breaching" ? ": a dead server must page" : ""})`,
        a.ActionsEnabled === true ? null : "actions DISABLED (muted)",
      ].filter((p): p is string => p !== null);
      if (wrong.length > 0) problems.push(`${spec.name}: ${wrong.join("; ")}`);
      actionSets.add(JSON.stringify([...listStrings(a.AlarmActions)].sort()));
      if (expect.alarmActions !== null && JSON.stringify([...listStrings(a.AlarmActions)].sort()) !== JSON.stringify([...expect.alarmActions].sort())) problems.push(`${spec.name}: actions [${listStrings(a.AlarmActions).join(", ")}], expected [${expect.alarmActions.join(", ")}]`);
    }
    if (actionSets.size > 1) problems.push("the five alarms notify different destinations");
    const hostNamesSet = new Set(specs.map((s) => s.name));
    const otherHostAlarms = [...alarms.metric, ...alarms.composite].map((a) => String(a.AlarmName)).filter((n) => n.startsWith(`${names.host}-`) && !hostNamesSet.has(n));
    if (otherHostAlarms.length > 0) problems.push(`unexpected host alarm(s): ${otherHostAlarms.join(", ")}`);
    const actions = [...actionSets][0] ?? "[]";
    if (problems.length > 0) checks.push(fail("observability: exactly five host alarms", problems.join("; ")));
    /* Whether the alarms notify anyone is a statement the operator makes (`--alarm-actions <arn,...>`, or `none` in
       staging); unstated, an alarm with no destination is indistinguishable from a muted one -- never a pass. */
    else if (expect.alarmActions === null) checks.push(notEvaluated("observability: exactly five host alarms", `the five alarms are the module's, on this host; they notify ${actions === "[]" ? "NO ONE" : actions} -- state the destinations with --alarm-actions <arn,...> (or none) to evaluate it`));
    else checks.push(pass("observability: exactly five host alarms", `${specs.map((s) => s.name.slice(names.host.length + 1)).join(", ")}; destinations ${actions === "[]" ? "none (as stated)" : actions}`));
  }
  /* The monthly budget. */
  if (expect.budget === "not-required") checks.push(skip("observability: the monthly budget", "--budget not-required (the owner's budget lives in another account: the payer / management account)"));
  else if (expect.instanceId === null) checks.push(skip("observability: the monthly budget", "no host yet (--instance-id none): the budget is created with the host (step D 9)"));
  else {
    const budgets = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.budgets), "Budgets");
    if (!budgets.ok) checks.push(notEvaluated("observability: the monthly budget", budgets.why));
    else {
      const b = budgets.items.find((x) => x.BudgetName === names.budget);
      const limit = obj(b?.BudgetLimit);
      const cents = usdCents(limit.Amount);
      checks.push(
        judge(
          "observability: the monthly budget",
          b !== undefined && b.BudgetType === "COST" && b.TimeUnit === "MONTHLY" && limit.Unit === "USD" && cents !== null && cents > 0 && cents <= BUDGET_CEILING_CENTS,
          `${names.budget}: COST, MONTHLY, ${String(limit.Amount)} USD`,
          b === undefined ? `no budget ${names.budget} in this account (required: --budget not-required only if it lives in the payer account)` : `${String(b.BudgetType)}, ${String(b.TimeUnit)}, ${String(limit.Amount)} ${String(limit.Unit)} (must be a monthly COST budget of at most $30)`,
        ),
      );
    }
  }
  return checks;
}

/* ------------------------------------------------------------------ */
/* The ECS era: drained (coexist) or absent (single-host)               */
/* ------------------------------------------------------------------ */

function activeCluster(read: HostRead, cluster: string): { readonly ok: true; readonly active: boolean } | { readonly ok: false; readonly why: string } {
  const clusters = listOf(read, "clusters");
  if (!clusters.ok) return clusters;
  /* describe-clusters answers a missing cluster in `failures` (MISSING) and a deleted one as INACTIVE. */
  return { ok: true, active: clusters.items.some((c) => c.clusterName === cluster && c.status !== "INACTIVE") };
}

export function checkLegacyServing(dir: string, expect: HostExpect): HostCheck[] {
  const names = hostNames(expect.environment);
  const checks: HostCheck[] = [];
  const final = expect.topology === "single-host";
  /* ECS: absent (final) / drained (coexist). A running or pending task beside the host is a SECOND SERVING WRITER. */
  const cluster = activeCluster(readHostEvidence(dir, HOST_EVIDENCE_FILES.ecsClusters), names.cluster);
  if (!cluster.ok) checks.push(notEvaluated(final ? "absent: ECS cluster and services" : "ECS drained: no second serving writer", cluster.why));
  else if (!cluster.active) checks.push(pass(final ? "absent: ECS cluster and services" : "ECS drained: no second serving writer", `no active cluster ${names.cluster}`));
  else if (final) checks.push(fail("absent: ECS cluster and services", `the cluster ${names.cluster} is ACTIVE: the ECS era was not removed (stacks/app compute = "none", step I)`));
  else {
    const services = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.ecsServices), "services");
    const tasks = readHostEvidence(dir, HOST_EVIDENCE_FILES.ecsRunningTasks);
    const taskArns = tasks.kind === "ok" && isArr(obj(tasks.value).taskArns) ? arr(obj(tasks.value).taskArns).map(String) : null;
    if (!services.ok || taskArns === null) checks.push(notEvaluated("ECS drained: no second serving writer", !services.ok ? services.why : tasks.kind === "ok" ? "the task listing has no taskArns list" : tasks.why));
    else {
      const live = services.items.filter((s) => s.status !== "INACTIVE" && (s.desiredCount !== 0 || s.runningCount !== 0 || s.pendingCount !== 0));
      checks.push(
        judge(
          "ECS drained: no second serving writer",
          live.length === 0 && taskArns.length === 0,
          `${services.items.length} service(s), every one desired 0 / running 0 / pending 0; no task running`,
          `${[...live.map((s) => `${String(s.serviceName)} desired ${String(s.desiredCount)} running ${String(s.runningCount)} pending ${String(s.pendingCount)}`), ...(taskArns.length > 0 ? [`${taskArns.length} task(s) running in ${names.cluster}`] : [])].join("; ")} -- a second serving writer beside the host (drain it: infra/aws/scripts/drain-pool)`,
        ),
      );
    }
  }
  /* The load balancer and its target groups: absent (final) / no target registered (coexist). */
  const lbs = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.loadBalancers), "LoadBalancers");
  const tgs = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.targetGroups), "TargetGroups");
  /* Exact names (modules/app: gs-<env>-alb, gs-<env>-<pool>): a prefix would also take another environment's
     (`gs-staging-` is `gs-staging-eu-`'s too). */
  const lbNames = new Set([`${names.prefix}alb`]);
  const tgNames = new Set(expect.legacyPools.map((p) => `${names.prefix}${p}`));
  const myLbs = lbs.ok ? lbs.items.filter((l) => lbNames.has(String(l.LoadBalancerName))).map((l) => String(l.LoadBalancerName)) : [];
  const myTgs = tgs.ok ? tgs.items.filter((t) => tgNames.has(String(t.TargetGroupName))) : [];
  if (final) {
    if (!lbs.ok || !tgs.ok) checks.push(notEvaluated("absent: load balancers and target groups", !lbs.ok ? lbs.why : (tgs as { why: string }).why));
    else checks.push(judge("absent: load balancers and target groups", myLbs.length === 0 && myTgs.length === 0, "none for this environment", `still present: ${[...myLbs, ...myTgs.map((t) => String(t.TargetGroupName))].join(", ")} (~$16+/month each ALB)`));
  } else if (!tgs.ok || !lbs.ok) checks.push(notEvaluated("ALB drained: no target registered", !tgs.ok ? tgs.why : (lbs as { why: string }).why));
  else {
    const problems: string[] = [];
    const unread: string[] = [];
    for (const tg of myTgs) {
      const name = String(tg.TargetGroupName);
      const health = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.targetHealth(name)), "TargetHealthDescriptions");
      if (!health.ok) unread.push(`${name}: ${health.why}`);
      else if (health.items.length > 0) problems.push(`${name}: ${health.items.length} target(s) [${health.items.map((t) => String(obj(t.TargetHealth).State)).join(", ")}]`);
    }
    if (problems.length > 0) checks.push(fail("ALB drained: no target registered", `${problems.join("; ")} -- a registered target is a serving ECS task beside the host`));
    else if (unread.length > 0) checks.push(notEvaluated("ALB drained: no target registered", unread.join("; ")));
    else checks.push(pass("ALB drained: no target registered", myTgs.length === 0 ? "no target group for this environment" : `${myTgs.length} target group(s), none with a target${myLbs.length > 0 ? ` (${myLbs.join(", ")} remains: the rollback path until step I)` : ""}`));
  }
  return checks;
}

/** The final state's absences beyond ECS / ALB: NAT, endpoints, the L6-5B alarm matrix, the ECS era's security groups, a stray environment EIP. */
export function checkFinalAbsence(dir: string, expect: HostExpect, host: Record<string, Json> | null): HostCheck[] {
  const names = hostNames(expect.environment);
  const checks: HostCheck[] = [];
  const vpc = host === null ? null : str(host.VpcId);
  const final = expect.topology === "single-host";
  const label = (what: string) => (final ? `absent: ${what}` : `coexistence: ${what}`);
  /* NAT gateways in the host's VPC (~$33/month each, before data). */
  const nats = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.natGateways), "NatGateways");
  if (vpc === null) checks.push(notEvaluated(label("NAT gateways"), "the host's VPC is not known"));
  else if (!nats.ok) checks.push(notEvaluated(label("NAT gateways"), nats.why));
  else {
    const vpcs = new Set([vpc, ...expect.legacyVpcs]);
    const live = nats.items.filter((n) => vpcs.has(String(n.VpcId)) && (n.State === "available" || n.State === "pending")).map((n) => String(n.NatGatewayId));
    const surplus = live.filter((n) => !expect.allowNatGateways.includes(n));
    const where = [...vpcs].join(", ");
    const elsewhere = nats.items.filter((n) => !vpcs.has(String(n.VpcId)) && (n.State === "available" || n.State === "pending")).map((n) => `${String(n.NatGatewayId)} (${String(n.VpcId)})`);
    if (elsewhere.length > 0) checks.push(skip(label("NAT gateways in other VPCs"), `${elsewhere.join(", ")} -- not judged: if one is the ECS era's VPC, name it with --legacy-vpc`));
    if (final) checks.push(judge(label("NAT gateways"), surplus.length === 0, live.length === 0 ? `none in ${where}` : `only ${live.join(", ")} (named as another workload's: --allow-nat)`, `${surplus.join(", ")} in ${where} (~$33/month each): delete it if nothing else uses it, or name it with --allow-nat`));
    else checks.push(skip(label("NAT gateways"), `${live.length === 0 ? "none" : live.join(", ")} in ${where} (tolerated until step I)`));
  }
  /* VPC endpoints: no interface endpoint in the host's VPC; none of the environment's (Terraform-tagged) of any type. */
  const endpoints = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.vpcEndpoints), "VpcEndpoints");
  if (vpc === null) checks.push(notEvaluated(label("interface VPC endpoints"), "the host's VPC is not known"));
  else if (!endpoints.ok) checks.push(notEvaluated(label("interface VPC endpoints"), endpoints.why));
  else {
    const live = endpoints.items.filter((e) => e.State !== "deleted" && e.State !== "Deleted" && e.State !== "deleting" && (e.VpcId === vpc || tagsOf(e).get("gs:environment") === expect.environment));
    const surplus = live.filter((e) => (e.VpcEndpointType !== "Gateway" || tagsOf(e).get("gs:environment") === expect.environment) && !expect.allowVpcEndpoints.includes(String(e.VpcEndpointId)));
    const describe = (e: Record<string, Json>) => `${String(e.VpcEndpointId)} (${String(e.VpcEndpointType)} ${String(e.ServiceName)})`;
    if (final) checks.push(judge(label("interface VPC endpoints"), surplus.length === 0, "none for this environment or VPC", `${surplus.map(describe).join(", ")} (~$7/month per interface endpoint per AZ): remove them, or name another workload's with --allow-vpc-endpoint`));
    else checks.push(skip(label("interface VPC endpoints"), `${surplus.length === 0 ? "none" : surplus.map(describe).join(", ")} (tolerated until step I)`));
  }
  /* The L6-5B alarm matrix (34 alarms, composites, suppressors). */
  const alarms = environmentAlarms(readHostEvidence(dir, HOST_EVIDENCE_FILES.alarms), expect.environment, expect.legacyPools);
  if (!alarms.ok) checks.push(notEvaluated(label("the L6-5B alarm matrix"), alarms.why));
  else {
    const hostOnes = new Set(Object.values(names.alarms));
    const obsolete = [...alarms.metric, ...alarms.composite].map((a) => String(a.AlarmName)).filter((n) => !hostOnes.has(n) && !n.startsWith(`${names.host}-`));
    if (final) checks.push(judge(label("the L6-5B alarm matrix"), obsolete.length === 0, "only the host's alarms", `${obsolete.length} alarm(s) of the ECS era remain: ${obsolete.slice(0, 6).join(", ")}${obsolete.length > 6 ? ", ..." : ""}`));
    else checks.push(skip(label("the L6-5B alarm matrix"), `${obsolete.length} ECS-era alarm(s) (tolerated until step I)`));
  }
  /* Alarms under the prefix that neither this environment's names nor its Environment dimension claim (another
     environment's -- or an older contract's renamed alarm): named, never judged silently. */
  const rawAlarms = readHostEvidence(dir, HOST_EVIDENCE_FILES.alarms);
  if (rawAlarms.kind === "ok" && alarms.ok) {
    const claimed = new Set([...alarms.metric, ...alarms.composite].map((a) => String(a.AlarmName)));
    const unclaimed = [...arr(obj(rawAlarms.value).MetricAlarms), ...arr(obj(rawAlarms.value).CompositeAlarms)].map(obj).map((a) => String(a.AlarmName)).filter((n) => n.startsWith(names.prefix) && !claimed.has(n));
    if (unclaimed.length > 0) checks.push(skip(label("alarms under the prefix not attributed to this environment"), `${unclaimed.slice(0, 8).join(", ")}${unclaimed.length > 8 ? ", ..." : ""} -- another environment's, or an older contract's: check by hand`));
  }
  /* The ECS era's security groups. */
  const groups = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.securityGroups), "SecurityGroups");
  if (!groups.ok) checks.push(notEvaluated(label("the ECS era's security groups"), groups.why));
  else {
    const left = groups.items.map((g) => String(g.GroupName)).filter((n) => names.legacySecurityGroups.includes(n));
    if (final) checks.push(judge(label("the ECS era's security groups"), left.length === 0, "none", `still present: ${left.join(", ")}`));
    else checks.push(skip(label("the ECS era's security groups"), `${left.length === 0 ? "none" : left.join(", ")} (tolerated until step I)`));
  }
  /* The ECS cluster's Container Insights log groups (stored and billed after the cluster is gone). */
  const insights = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.containerInsightsLogGroups), "logGroups");
  if (!insights.ok) checks.push(notEvaluated(label("Container Insights log groups"), insights.why));
  else {
    const left = insights.items.map((g) => String(g.logGroupName)).filter((n) => n.startsWith(`/aws/ecs/containerinsights/${names.cluster}/`));
    if (final) checks.push(judge(label("Container Insights log groups"), left.length === 0, "none", `still present: ${left.join(", ")} (export, then delete)`));
    else checks.push(skip(label("Container Insights log groups"), `${left.length === 0 ? "none" : left.join(", ")} (tolerated until step I)`));
  }
  /* Any other Elastic IP tagged for this environment. */
  const addresses = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.addresses), "Addresses");
  if (!addresses.ok) checks.push(notEvaluated(label("no second EIP"), addresses.why));
  else {
    /* Another EIP tagged for this environment, or ANY unassociated EIP (a released NAT's, step 23 -- billed while idle),
       unless named as another workload's (`--allow-eip`). */
    const extra = addresses.items
      .filter((a) => (tagsOf(a).get("gs:environment") === expect.environment && tagsOf(a).get("gs:component") !== "single-host") || (a.AssociationId === undefined && a.NetworkInterfaceId === undefined && a.InstanceId === undefined))
      .filter((a) => !(tagsOf(a).get("gs:environment") === expect.environment && tagsOf(a).get("gs:component") === "single-host"))
      .filter((a) => !expect.allowEips.includes(String(a.AllocationId)))
      .map((a) => `${String(a.PublicIp)} (${String(a.AllocationId)}${a.AssociationId === undefined ? ", unassociated" : ""})`);
    if (final) checks.push(judge(label("no second EIP"), extra.length === 0, "no other Elastic IP of this environment, and none unassociated", `${extra.join(", ")} besides the host's ($3.60/month each): release it, or name another workload's with --allow-eip`));
    else checks.push(skip(label("no second EIP"), `${extra.length === 0 ? "none" : extra.join(", ")} besides the host's (tolerated until step I)`));
  }
  return checks;
}

/* ------------------------------------------------------------------ */
/* The runtime snapshot: the roles, the money games, RELAYQ             */
/* ------------------------------------------------------------------ */

type ReadJson = { readonly state?: Json; readonly value?: Json; readonly detail?: Json; readonly format?: Json };
const readOk = (r: Json): Record<string, Json> | null => (obj(r).state === "ok" ? obj(obj(r).value) : null);
const readWhy = (r: Json): string => {
  const x = obj(r) as ReadJson;
  return x.state === "absent" ? "absent" : x.state === "unreadable" ? `unreadable (${String(x.format)})` : x.state === "unavailable" ? `could not be read (${String(x.detail).slice(0, 120)})` : "not in the snapshot";
};

export function checkRuntimeSnapshot(dir: string, expect: HostExpect, escrow: boolean): HostCheck[] {
  const NAMES = ["roles: SYSTEM/ROUTING primary is the host's pool", "roles: the pool writer", "roles: identity writer held by the pool writer", "roles: relayer held by the pool writer", "money games: open money games settled"];
  const read = readHostEvidence(dir, HOST_EVIDENCE_FILES.runtimeSnapshot);
  if (read.kind !== "ok") return NAMES.map((n) => notEvaluated(n, `${read.why} (gamesDoctor aws host-snapshot --out <evidence>/${HOST_EVIDENCE_FILES.runtimeSnapshot}, operator credentials)`));
  const s = obj(read.value);
  const checks: HostCheck[] = [];
  const identity = s.format === HOST_RUNTIME_SNAPSHOT_FORMAT && s.environment === expect.environment && s.generation === expect.generation && s.configured_pool === expect.pool;
  checks.push(judge("roles: the runtime snapshot", identity, `${HOST_RUNTIME_SNAPSHOT_FORMAT}, ${expect.environment}, generation ${expect.generation}, pool ${expect.pool}`, `format ${String(s.format)}, ${String(s.environment)}, generation ${String(s.generation)}, pool ${String(s.configured_pool)}`));
  checks.push(freshness("roles: the runtime snapshot fresh", evidenceTime(s.captured_at), expect));
  if (!identity) return [...checks, ...NAMES.map((n) => notEvaluated(n, "the snapshot is not this deployment's"))];
  const status = obj(s.status);
  const routing = readOk(status.routing);
  checks.push(routing === null ? notEvaluated(NAMES[0], `SYSTEM/ROUTING ${readWhy(status.routing)}`) : judge(NAMES[0], routing.primary_pool === expect.pool, `primary ${expect.pool}, version ${String(routing.routing_version)}`, `the routing's primary is ${String(routing.primary_pool)}, the host serves ${expect.pool}`));
  const appgen = readOk(status.appgen);
  checks.push(appgen === null ? notEvaluated("roles: APPGEN", readWhy(status.appgen)) : judge("roles: APPGEN", appgen.matches_configuration === true && appgen.current_generation === expect.generation, `generation ${expect.generation}`, `APPGEN ${String(appgen.current_generation)}, the configuration's ${expect.generation}`));
  /* The pool writer: POOL#<host pool>'s current task. */
  const pools = arr(status.pools).map(obj);
  const mine = pools.find((p) => p.pool === expect.pool);
  const poolItem = mine === undefined ? null : readOk(mine.item);
  const writer = poolItem === null ? null : str(poolItem.writer_task);
  checks.push(writer === null ? notEvaluated(NAMES[1], `POOL#${expect.pool} ${mine === undefined ? "is not in the snapshot" : readWhy(mine.item)}`) : pass(NAMES[1], `POOL#${expect.pool}: epoch ${String(poolItem?.writer_epoch)}, task ${writer}`));
  /* The identity writer and the relayer: held by THAT task -- held by any other task or pool is a second serving writer. */
  const id = obj(status.identity_writer);
  const idRole = readOk(id.role);
  const idHolder = obj(id.holder);
  if (idRole === null || writer === null) checks.push(notEvaluated(NAMES[2], idRole === null ? `the identity-writer role ${readWhy(id.role)}` : "the pool writer is not known"));
  else checks.push(judge(NAMES[2], idRole.task === writer && idRole.pool === expect.pool && idHolder.holder === "current" && idHolder.primary === true, `${writer} of ${expect.pool}, current, primary`, `the identity writer is ${String(idRole.task)} of ${String(idRole.pool)} (${String(idHolder.holder)}${idHolder.primary === false ? ", NOT primary" : ""}); the host pool's writer is ${writer} -- a second serving writer, or a role not yet taken`));
  if (!escrow) checks.push(skip(NAMES[3], "no escrow configured (no relayer)"));
  else {
    const r = obj(status.relayer);
    const mirror = readOk(r.mirror);
    const holder = obj(r.holder);
    if (Object.keys(r).length === 0) checks.push(notEvaluated(NAMES[3], "the snapshot has no relayer (its escrow configuration was not read)"));
    else if (mirror === null || writer === null) checks.push(notEvaluated(NAMES[3], mirror === null ? `the relayer mirror ${readWhy(r.mirror)}` : "the pool writer is not known"));
    else checks.push(judge(NAMES[3], r.consistency === "mirrored" && mirror.task === writer && mirror.pool === expect.pool && holder.holder === "current" && holder.primary === true, `${String(r.account)}: ${writer}, mirror = ledger fence epoch ${String(mirror.epoch)}`, `relayer ${String(r.account)} ${String(r.consistency)}, held by ${String(mirror.task)} of ${String(mirror.pool)} (${String(holder.holder)}); the host pool's writer is ${writer}`));
  }
  const findings = arr(status.findings).map(String);
  checks.push(judge("roles: no finding", findings.length === 0, "gamesDoctor aws status: no finding", findings.slice(0, 5).join("; ")));
  /* Every other pool of the route table (coexistence: the ECS era's p2) -- reported, never a writer of the roles. */
  const others = arr(s.route_pools).map(obj).filter((p) => p.pool !== expect.pool);
  if (others.length > 0) checks.push(skip("roles: the other route pools", others.map((p) => `POOL#${String(p.pool)} ${readOk(p.item) === null ? readWhy(p.item) : `epoch ${String(readOk(p.item)?.writer_epoch)}, task ${String(readOk(p.item)?.writer_task)}`}`).join("; ") + " (historical writers; ECS drained is judged above)"));
  /* The open money games: their owners an ordinary state, the indexes readable. */
  const money = obj(s.money);
  if (money.source !== "open-money" || !isArr(money.games)) checks.push(notEvaluated(NAMES[4], "the snapshot has no open-money listing"));
  else {
    const games = arr(money.games).map(obj);
    const odd = games.filter((g) => !SETTLED_OWNERS.includes(String(g.owner)));
    const problems = arr(money.problems).map(String);
    const counts: Record<string, number> = {};
    for (const g of games) counts[String(g.owner)] = (counts[String(g.owner)] ?? 0) + 1;
    checks.push(judge(NAMES[4], odd.length === 0 && problems.length === 0, `${games.length} open money game(s)${games.length > 0 ? `: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}` : ""}`, [...odd.map((g) => `${String(g.game_id)} ${String(g.owner)}`), ...problems].slice(0, 6).join("; ")));
  }
  /* RELAYQ, read live by the verifier (strongly consistent, every page). */
  if (expect.relayer === null) checks.push(skip("money games: RELAYQ", "no escrow configured"));
  else {
    const q = expect.relayer.queue;
    if (q.state === "unknown") checks.push(notEvaluated("money games: RELAYQ", `RELAYQ#${expect.relayer.address}: ${q.detail}`));
    else checks.push(pass("money games: RELAYQ", `RELAYQ#${expect.relayer.address}: ${q.state === "empty" ? "empty" : `${q.entries} open entr${q.entries === 1 ? "y" : "ies"} (relayer work in progress)`}`));
  }
  return checks;
}

/* ------------------------------------------------------------------ */
/* Terraform's outputs (optional) and the whole directory               */
/* ------------------------------------------------------------------ */

export function checkTerraformOutputs(dir: string, expect: HostExpect, host: Record<string, Json> | null): HostCheck {
  const read = readHostEvidence(dir, HOST_EVIDENCE_FILES.terraformOutputs);
  const asked = fs.existsSync(path.join(dir, HOST_EVIDENCE_FILES.terraformOutputs)) || fs.existsSync(path.join(dir, "terraform-outputs.error.json"));
  if (read.kind !== "ok") return asked ? notEvaluated("Terraform outputs = what runs", read.why) : skip("Terraform outputs = what runs", `${read.why} (optional: capture-host-evidence --terraform-dir infra/aws/stacks/single-host, from the repository root)`);
  const o = obj(read.value);
  const v = (k: string) => obj(o[k]).value;
  const names = hostNames(expect.environment);
  const problems = [
    expect.instanceId === null || v("instance_id") === expect.instanceId ? null : `instance_id ${String(v("instance_id"))}`,
    expect.originHostname === null || v("origin_hostname") === expect.originHostname ? null : `origin_hostname ${String(v("origin_hostname"))}`,
    v("app_role_arn") === `arn:aws:iam::${expect.account}:role/${names.role}` ? null : `app_role_arn ${String(v("app_role_arn"))}`,
    v("log_group") === names.logGroup ? null : `log_group ${String(v("log_group"))}`,
    v("runtime_parameter_arn") === expect.authorities.runtimeParameterArn ? null : `runtime_parameter_arn ${String(v("runtime_parameter_arn"))}`,
    host === null || v("public_ip") === host.PublicIpAddress ? null : `public_ip ${String(v("public_ip"))} (the host's is ${String(host.PublicIpAddress)})`,
  ].filter((p): p is string => p !== null);
  return judge("Terraform outputs = what runs", problems.length === 0, "instance, origin, role, log group, runtime document and public address agree", problems.join("; "));
}

/** Every host-topology control-plane check over a host evidence directory. */
export function checkHostEvidenceDirectory(dir: string, expect: HostExpect, options: { readonly escrow: boolean }): HostCheck[] {
  const checks: HostCheck[] = [...checkHostManifest(readHostEvidence(dir, HOST_EVIDENCE_FILES.manifest), expect, dir)];
  if (expect.instanceId !== null && expect.originHostname === null) checks.push(fail("host: origin hostname", "--origin-hostname is required with a host"));
  const ec2 = checkHostInstance(dir, expect);
  checks.push(...ec2.checks);
  if (expect.instanceId === null) {
    if (expect.topology === "single-host") checks.push(fail("host", "the final state needs its host (--instance-id)"));
    checks.push(skip("host: network, IAM, health", "no host yet (--instance-id none): nothing to verify but its absence"));
  } else if (ec2.host !== null) {
    checks.push(...checkHostNetwork(dir, expect, ec2.host));
    checks.push(...checkHostIam(dir, expect));
    checks.push(...checkHostRuntime(dir, expect));
  } else checks.push(notEvaluated("host: network, IAM, health", "the host is not in the evidence"));
  checks.push(...checkHostEdge(dir, expect));
  checks.push(...checkHostObservability(dir, expect));
  checks.push(...checkLegacyServing(dir, expect));
  if (expect.instanceId !== null) checks.push(...checkFinalAbsence(dir, expect, ec2.host));
  checks.push(...checkRuntimeSnapshot(dir, expect, options.escrow));
  checks.push(checkTerraformOutputs(dir, expect, ec2.host));
  return checks;
}

/* ------------------------------------------------------------------ */
/* The evidence summary (machine- and human-readable)                   */
/* ------------------------------------------------------------------ */

/** What the evidence SAYS, area by area (null where it could not be read) -- identifiers and states only, no secret. */
export function hostFacts(dir: string, expect: HostExpect): Record<string, Json> {
  const ok = (file: string): Record<string, Json> | null => {
    const r = readHostEvidence(dir, file);
    return r.kind === "ok" ? obj(r.value) : null;
  };
  const manifest = ok(HOST_EVIDENCE_FILES.manifest);
  const instances = hostInstances(readHostEvidence(dir, HOST_EVIDENCE_FILES.instances), expect.environment);
  const host = instances.ok ? (instances.items.find((i) => i.InstanceId === expect.instanceId) ?? null) : null;
  const addresses = listOf(readHostEvidence(dir, HOST_EVIDENCE_FILES.addresses), "Addresses");
  const eip = addresses.ok ? (addresses.items.find((a) => tagsOf(a).get("gs:environment") === expect.environment && tagsOf(a).get("gs:component") === "single-host") ?? null) : null;
  const dist = ok(HOST_EVIDENCE_FILES.distributionConfig);
  const config = obj(dist?.DistributionConfig);
  const origins = arr(obj(config.Origins).Items).map(obj);
  const gsBehaviour = arr(obj(config.CacheBehaviors).Items).map(obj).find((b) => b.PathPattern === "/gs*");
  const health = ok(HOST_EVIDENCE_FILES.hostHealth);
  const line = health === null ? null : parseHostHealth(health.StandardOutputContent);
  const snapshot = ok(HOST_EVIDENCE_FILES.runtimeSnapshot);
  const status = obj(snapshot?.status);
  const alarms = environmentAlarms(readHostEvidence(dir, HOST_EVIDENCE_FILES.alarms), expect.environment, expect.legacyPools);
  const profile = ok(HOST_EVIDENCE_FILES.instanceProfile);
  const outputs = ok(HOST_EVIDENCE_FILES.terraformOutputs);
  const money = obj(snapshot?.money);
  return {
    source: manifest === null ? null : { commit: manifest.source_commit ?? null, dirty: manifest.source_dirty ?? null, captured_at: manifest.captured_at ?? null, caller: manifest.caller_arn ?? null },
    terraform: outputs === null ? null : Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, obj(v).value ?? null])),
    ec2:
      host === null
        ? null
        : { instance_id: host.InstanceId, state: obj(host.State).Name, type: host.InstanceType, architecture: host.Architecture, ami: host.ImageId, vpc: host.VpcId, subnet: host.SubnetId, launched_at: host.LaunchTime ?? null, imds_tokens: obj(host.MetadataOptions).HttpTokens ?? null, hop_limit: obj(host.MetadataOptions).HttpPutResponseHopLimit ?? null },
    iam: { instance_profile: host === null ? null : (obj(host.IamInstanceProfile).Arn ?? null), roles: profile === null ? null : arr(obj(profile.InstanceProfile).Roles).map((r) => obj(r).Arn) },
    network: host === null ? null : { eni: arr(host.NetworkInterfaces).map((n) => obj(n).NetworkInterfaceId), security_groups: arr(host.SecurityGroups).map((g) => `${String(obj(g).GroupId)} (${String(obj(g).GroupName)})`), public_ip: host.PublicIpAddress ?? null },
    eip: eip === null ? null : { public_ip: eip.PublicIp, allocation: eip.AllocationId, eni: eip.NetworkInterfaceId ?? null },
    cloudfront: dist === null ? null : { gs_origin: gsBehaviour === undefined ? null : (origins.find((o) => o.Id === gsBehaviour.TargetOriginId)?.DomainName ?? null), gs_request_policy: gsBehaviour?.OriginRequestPolicyId ?? null, site_origin: origins.find((o) => o.Id === obj(config.DefaultCacheBehavior).TargetOriginId)?.DomainName ?? null },
    host: line === null ? null : { ...line, at: health?.ExecutionEndDateTime ?? null },
    generation: snapshot === null ? null : { appgen: readOk(status.appgen), routing: readOk(status.routing) },
    roles:
      snapshot === null
        ? null
        : {
            pools: arr(status.pools).map((p) => ({ pool: obj(p).pool, item: readOk(obj(p).item) })),
            identity_writer: readOk(obj(status.identity_writer).role),
            relayer: obj(status.relayer).account === undefined ? null : { account: obj(status.relayer).account, consistency: obj(status.relayer).consistency, mirror: readOk(obj(status.relayer).mirror) },
            findings: arr(status.findings),
          },
    alarms: alarms.ok ? [...alarms.metric, ...alarms.composite].map((a) => ({ name: a.AlarmName, state: a.StateValue ?? null })) : null,
    money: snapshot === null ? null : { open_money_games: isArr(money.games) ? arr(money.games).length : null, problems: arr(money.problems) },
    relayq: expect.relayer === null ? null : { address: expect.relayer.address, ...expect.relayer.queue },
  };
}

const STATUS_WORD: Record<HostCheckStatus, string> = { pass: "PASS", fail: "FAIL", "not-evaluated": "NOT EVALUATED", skipped: "SKIP" };

export function verdictOf(checks: ReadonlyArray<{ readonly status: string }>): "PASS" | "FAIL" | "NOT EVALUATED" {
  if (checks.some((c) => c.status === "fail")) return "FAIL";
  if (checks.some((c) => c.status === "not-evaluated")) return "NOT EVALUATED";
  return "PASS";
}

/** The report: `host-evidence.json` (HOST-VERIFY-REPORT/v1) and `host-evidence.md`, side by side, written atomically. */
export function writeHostReport(outDir: string, report: { readonly topology: HostTopology; readonly environment: string; readonly generation: number; readonly at: number; readonly facts: Record<string, Json>; readonly checks: ReadonlyArray<{ readonly name: string; readonly status: string; readonly detail: string }> }): { readonly json: string; readonly markdown: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const verdict = verdictOf(report.checks);
  const machine = { format: HOST_REPORT_FORMAT, topology: report.topology, environment: report.environment, generation: report.generation, at: new Date(report.at).toISOString(), verdict, facts: report.facts, checks: report.checks };
  const lines: string[] = [
    `# Host verification -- ${report.environment} (${report.topology})`,
    "",
    `**Verdict: ${verdict}** -- ${report.checks.filter((c) => c.status === "pass").length} pass, ${report.checks.filter((c) => c.status === "fail").length} fail, ${report.checks.filter((c) => c.status === "not-evaluated").length} not evaluated, ${report.checks.filter((c) => c.status === "skipped").length} skipped. Generated ${machine.at}; generation ${report.generation}.`,
    "",
    "## Evidence",
    "",
  ];
  for (const [area, value] of Object.entries(report.facts)) lines.push(`- **${area}**: ${value === null ? "_not read_" : "`" + JSON.stringify(value).replace(/`/g, "'") + "`"}`);
  lines.push("", "## Checks", "", "| Result | Check | Detail |", "|---|---|---|");
  for (const c of report.checks) lines.push(`| ${STATUS_WORD[c.status as HostCheckStatus] ?? c.status} | ${c.name.replace(/\|/g, "\\|")} | ${c.detail.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
  const json = path.join(outDir, "host-evidence.json");
  const markdown = path.join(outDir, "host-evidence.md");
  for (const [file, text] of [
    [json, `${JSON.stringify(machine, null, 2)}\n`],
    [markdown, `${lines.join("\n")}\n`],
  ] as const) {
    fs.writeFileSync(`${file}.partial`, text);
    fs.renameSync(`${file}.partial`, file);
  }
  return { json, markdown };
}
