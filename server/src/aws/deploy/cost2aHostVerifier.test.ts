// server/src/aws/deploy/cost2aHostVerifier.test.ts
//
// COST-2A: the single-host control-plane verifier and its evidence, over MOCKED AWS answers (the JSON the read-only AWS
// CLI prints; no account, no network). What is pinned:
//   §1 a good final-state capture PASSES; a good coexistence capture PASSES; the same coexistence capture FAILS the final
//      state (a forgotten ECS / ALB / NAT / endpoint / L6 alarm / pool log group is a hard fail there);
//   §2 every required negative: two hosts, a wrong instance type, unlimited CPU credits, IMDSv1, public 8917, unexpected
//      SSH, a wrong EIP, a wrong CloudFront origin, a missing host role, a wrong KMS allow-list, a second serving writer
//      (ECS beside the host, a registered target, a role held by another task) -- and more of each kind;
//   §3 a read failure is NOT EVALUATED, never PASS: EVERY evidence file, removed or written as an error by the capture,
//      leaves the verdict short of PASS (an exhaustive sweep), and an absence check never passes on a failed listing;
//   §4 `awsDeploy verify --topology ...` end to end over the task's own document parser and a fake DynamoDB (PASS -> 0,
//      FAIL -> 1, NOT EVALUATED -> 3; the record and the report), and the refusals that keep the topologies apart;
//   §5 the sources: the capture scripts are describe / get / list only (and their one opt-in Run Command is the fixed
//      gs-health), the fixtures are Terraform's rendering, the allow-list and alarm table are the single-host module's.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { DescribeContinuousBackupsCommand, DescribeTableCommand, DescribeTimeToLiveCommand, GetItemCommand, QueryCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

import type { ParameterSource } from "../runtime/configSource";
import { appgenItem } from "./bootstrap";
import { EXIT_FAILED, EXIT_NOT_EVALUATED, EXIT_OK, EXIT_USAGE, report, runDeployCommand, type DeployDeps } from "./commands";
import { CACHING_DISABLED_POLICY_ID, type Check } from "./deployVerify";
import { bootstrapGenerationMarker, generationMarkerItem } from "../game/generationMarker";
import {
  checkHostEvidenceDirectory,
  ecsEraAlarmNames,
  hostAlarmSpecs,
  HOST_EVIDENCE_FILES,
  HOST_EVIDENCE_FORMAT,
  HOST_INSTANCE_TYPES,
  HOST_REPORT_FORMAT,
  HOST_RUNTIME_SNAPSHOT_FORMAT,
  judgeHostIngress,
  usdCents,
  verdictOf,
  type HostCheck,
  type HostExpect,
} from "./hostVerify";

const REPO = path.resolve(__dirname, "../../../../../.."); // dist/server/src/aws/deploy -> the repository
const INFRA = path.join(REPO, "infra/aws");
const fixture = (name: string): string => fs.readFileSync(path.join(INFRA, "fixtures", name), "utf8");

/* ------------------------------------------------------------------ */
/* The deployment the captures describe                                 */
/* ------------------------------------------------------------------ */

const NOW = Date.parse("2026-10-02T18:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const ENV = "staging";
const REGION = "us-east-1";
const ACCOUNT = "111111111111";
const ID = "i-0123456789abcdef0";
const ENI = "eni-0aaaaaaaaaaaaaaa1";
const SG = "sg-0aaaaaaaaaaaaaaa1";
const VPC = "vpc-0123456789abcdef0";
const AMI = "ami-0123456789abcdef0";
const VOL = "vol-0aaaaaaaaaaaaaaa1";
const IP = "203.0.113.10";
const PL = "pl-3b927c52";
const ORIGIN = "gs-origin.example.org";
const ALB_ORIGIN = "gs-alb-origin.example.org";
const SITE = "site.example.org";
const DIGEST = `sha256:${"a".repeat(64)}`;
const BUILD = "b42";
const TASK = "t-0123456789abcdef";
const RELAYER = "juno1xc5etfhxjg4qfc9cx25qh3tvxdcf5skjj5epte";
const RUNTIME_ARN = `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/gs/${ENV}/runtime/p1`;
const JUNO_ARN = `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/gs/${ENV}/juno-backend`;
const LEDGER_ARN = `arn:aws:dynamodb:${REGION}:222222222222:table/gs-${ENV}-ledger`;
const KEYS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"].map((k) => `arn:aws:kms:${REGION}:222222222222:key/${k}`);
const tag = (Key: string, Value: string) => ({ Key, Value });
const HOST_TAGS = [tag("gs:environment", ENV), tag("gs:component", "single-host"), tag("gs:pool", "p1"), tag("gs:arch", "arm64"), tag("Name", `gs-${ENV}-host`)];

type Json = unknown;
type Files = Record<string, Json>;

function hostInstance(over: Record<string, Json> = {}): Record<string, Json> {
  return {
    InstanceId: ID,
    InstanceType: "t4g.small",
    Architecture: "arm64",
    ImageId: AMI,
    State: { Name: "running" },
    VpcId: VPC,
    SubnetId: "subnet-0bbbbbbbbbbbbbbb1",
    PublicIpAddress: IP,
    Monitoring: { State: "disabled" },
    IamInstanceProfile: { Arn: `arn:aws:iam::${ACCOUNT}:instance-profile/gs-${ENV}-host-app` },
    MetadataOptions: { HttpTokens: "required", HttpPutResponseHopLimit: 2, HttpEndpoint: "enabled", HttpProtocolIpv6: "disabled", InstanceMetadataTags: "disabled" },
    RootDeviceName: "/dev/xvda",
    BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeId: VOL } }],
    NetworkInterfaces: [{ NetworkInterfaceId: ENI, Attachment: { DeviceIndex: 0 }, Groups: [{ GroupId: SG, GroupName: `gs-${ENV}-host` }] }],
    SecurityGroups: [{ GroupId: SG, GroupName: `gs-${ENV}-host` }],
    Tags: HOST_TAGS,
    LaunchTime: iso(NOW - 86_400_000),
    ...over,
  };
}

const perm = (protocol: string, from: number, to: number, sources: { cidrs?: string[]; prefixLists?: string[]; groups?: string[] } = {}) => ({
  IpProtocol: protocol,
  FromPort: from,
  ToPort: to,
  IpRanges: (sources.cidrs ?? []).map((CidrIp) => ({ CidrIp })),
  Ipv6Ranges: [],
  PrefixListIds: (sources.prefixLists ?? []).map((PrefixListId) => ({ PrefixListId })),
  UserIdGroupPairs: (sources.groups ?? []).map((GroupId) => ({ GroupId })),
});
const HOST_INGRESS = [perm("tcp", 443, 443, { prefixLists: [PL] }), perm("tcp", 80, 80, { cidrs: ["0.0.0.0/0"] })];
const hostGroup = (ingress: Json[] = HOST_INGRESS, egress: Json[] = [perm("tcp", 443, 443, { cidrs: ["0.0.0.0/0"] })]) => ({ GroupName: `gs-${ENV}-host`, GroupId: SG, VpcId: VPC, IpPermissions: ingress, IpPermissionsEgress: egress });

function healthLine(over: Record<string, string> = {}): string {
  return JSON.stringify({ server: "active", caddy: "active", build: BUILD, digest: DIGEST, running_digest: DIGEST, hold: "none", healthz: "200", readyz: "200", origin_tls_readyz: "200", origin_hostname: ORIGIN, static_credentials: "none", ...over });
}

function alarms(instanceId = ID, extra: Json[] = [], over: (a: Record<string, Json>) => Record<string, Json> = (a) => a): Json {
  return {
    MetricAlarms: [
      ...hostAlarmSpecs(ENV, instanceId).map((s) =>
        over({ AlarmName: s.name, Namespace: s.namespace, MetricName: s.metric, Dimensions: [{ Name: s.dimension[0], Value: s.dimension[1] }], ComparisonOperator: s.comparison, Threshold: s.threshold, TreatMissingData: s.missing, ActionsEnabled: true, AlarmActions: [], OKActions: [], StateValue: "OK" }),
      ),
      ...extra,
    ],
    CompositeAlarms: [],
  };
}
const L6_ALARM = { AlarmName: `gs-${ENV}-p1-a1-pool-lost`, Namespace: "18Cosmos/GameServer", MetricName: "TaskLost", Dimensions: [{ Name: "Environment", Value: ENV }, { Name: "Pool", Value: "p1" }], ActionsEnabled: true };

function poolRead(task = TASK, epoch = 7) {
  return { state: "ok", value: { writer_epoch: epoch, writer_task: task, taken_at: NOW - 3_600_000, extra: [] } };
}
function snapshot(over: { identityTask?: string; relayerTask?: string; relayerConsistency?: string; escrow?: boolean; routes?: string[]; findings?: string[]; money?: Json; primary?: string; generation?: number } = {}): Json {
  const escrow = over.escrow ?? true;
  return {
    format: HOST_RUNTIME_SNAPSHOT_FORMAT,
    captured_at: iso(NOW - 45_000),
    environment: ENV,
    region: REGION,
    generation: over.generation ?? 1,
    configured_pool: "p1",
    status: {
      target: { kind: "aws", environment: ENV },
      routing: { state: "ok", value: { primary_pool: over.primary ?? "p1", routing_version: 3, updated_at: NOW - 86_400_000, updated_by: "bootstrap", claim: "c" } },
      appgen: { state: "ok", value: { current_generation: 1, matches_configuration: true } },
      pools: [{ pool: "p1", named_as: ["configured", "primary", "identity-writer", ...(escrow ? ["relayer"] : [])], item: poolRead() }],
      identity_writer: { role: { state: "ok", value: { epoch: 3, task: over.identityTask ?? TASK, pool: "p1", taken_at: NOW - 3_600_000 } }, holder: { holder: (over.identityTask ?? TASK) === TASK ? "current" : "superseded", primary: true, detail: "" } },
      relayer: escrow
        ? { account: RELAYER, mirror: { state: "ok", value: { epoch: 5, task: over.relayerTask ?? TASK, pool: "p1", pool_epoch: 7, taken_at: NOW - 3_600_000 } }, fence: { state: "ok", value: { epoch: 5, token: "x" } }, consistency: over.relayerConsistency ?? "mirrored", holder: { holder: (over.relayerTask ?? TASK) === TASK ? "current" : "superseded", primary: true, detail: "" } }
        : null,
      findings: over.findings ?? [],
    },
    route_pools: (over.routes ?? ["p1"]).map((pool) => ({ pool, item: pool === "p1" ? poolRead() : poolRead("t-ecs00000000000002", 4) })),
    money: over.money ?? { source: "open-money", games: [], problems: [] },
  };
}

/** A complete, healthy capture of the FINAL single-host state (escrow on). */
function finalFiles(): Files {
  return {
    [HOST_EVIDENCE_FILES.callerIdentity]: { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/gs-${ENV}-bootstrap/operator`, UserId: "AROAEXAMPLE:operator" },
    [HOST_EVIDENCE_FILES.instances]: { Reservations: [{ Instances: [hostInstance()] }] },
    [HOST_EVIDENCE_FILES.instancesByProfile]: { Reservations: [{ Instances: [hostInstance()] }] },
    [HOST_EVIDENCE_FILES.creditSpecification]: { InstanceCreditSpecifications: [{ InstanceId: ID, CpuCredits: "standard" }] },
    [HOST_EVIDENCE_FILES.terminationProtection]: { InstanceId: ID, DisableApiTermination: { Value: true } },
    [HOST_EVIDENCE_FILES.volumes]: { Volumes: [{ VolumeId: VOL, Encrypted: true }] },
    [HOST_EVIDENCE_FILES.image]: { Images: [{ ImageId: AMI, Architecture: "arm64" }] },
    [HOST_EVIDENCE_FILES.networkInterfaces]: { NetworkInterfaces: [{ NetworkInterfaceId: ENI, SourceDestCheck: true, Attachment: { InstanceId: ID, DeviceIndex: 0 }, TagSet: [tag("Name", `gs-${ENV}-host`)] }] },
    [HOST_EVIDENCE_FILES.addresses]: {
      Addresses: [
        { PublicIp: IP, AllocationId: "eipalloc-0123456789abcdef0", AssociationId: "eipassoc-0123456789abcdef0", NetworkInterfaceId: ENI, Domain: "vpc", Tags: [tag("gs:environment", ENV), tag("gs:component", "single-host")] },
        { PublicIp: "198.51.100.7", AllocationId: "eipalloc-0ffffffffffffffff", AssociationId: "eipassoc-0ffffffffffffffff", NetworkInterfaceId: "eni-0ffffffffffffffff", Domain: "vpc", Tags: [tag("team", "other-workload")] },
      ],
    },
    [HOST_EVIDENCE_FILES.securityGroups]: { SecurityGroups: [hostGroup()] },
    [HOST_EVIDENCE_FILES.prefixList]: { PrefixLists: [{ PrefixListId: PL, PrefixListName: "com.amazonaws.global.cloudfront.origin-facing" }] },
    [HOST_EVIDENCE_FILES.natGateways]: { NatGateways: [] },
    [HOST_EVIDENCE_FILES.vpcEndpoints]: { VpcEndpoints: [] },
    [HOST_EVIDENCE_FILES.ssmInstance]: { InstanceInformationList: [{ InstanceId: ID, PingStatus: "Online" }] },
    [HOST_EVIDENCE_FILES.instanceProfile]: { InstanceProfile: { InstanceProfileName: `gs-${ENV}-host-app`, Roles: [{ RoleName: `gs-${ENV}-host-app`, Arn: `arn:aws:iam::${ACCOUNT}:role/gs-${ENV}-host-app` }] } },
    [HOST_EVIDENCE_FILES.role]: { Role: { RoleName: `gs-${ENV}-host-app`, Arn: `arn:aws:iam::${ACCOUNT}:role/gs-${ENV}-host-app`, AssumeRolePolicyDocument: JSON.parse(fixture("host-assume-role-policy-staging.json")) } },
    [HOST_EVIDENCE_FILES.roleAttachedPolicies]: { AttachedPolicies: [] },
    [HOST_EVIDENCE_FILES.roleInlinePolicies]: { PolicyNames: ["gs-single-host-runtime"] },
    [HOST_EVIDENCE_FILES.rolePolicy]: { RoleName: `gs-${ENV}-host-app`, PolicyName: "gs-single-host-runtime", PolicyDocument: JSON.parse(fixture("host-role-policy-staging.json")) },
    [HOST_EVIDENCE_FILES.distributionConfig]: {
      ETag: "E1",
      DistributionConfig: {
        Origins: {
          Items: [
            { Id: "site", DomainName: SITE, CustomOriginConfig: { OriginProtocolPolicy: "https-only" } },
            { Id: "gs-alb", DomainName: ORIGIN, CustomOriginConfig: { OriginProtocolPolicy: "https-only" } },
          ],
        },
        DefaultCacheBehavior: { TargetOriginId: "site" },
        CacheBehaviors: {
          Items: [{ PathPattern: "/gs*", TargetOriginId: "gs-alb", ViewerProtocolPolicy: "https-only", AllowedMethods: { Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"] }, CachePolicyId: CACHING_DISABLED_POLICY_ID, OriginRequestPolicyId: "orp-1" }],
        },
      },
    },
    [HOST_EVIDENCE_FILES.originRequestPolicy]: {
      OriginRequestPolicy: {
        Id: "orp-1",
        OriginRequestPolicyConfig: {
          Name: `gs-${ENV}-gs-all-query-cookies-origin`,
          QueryStringsConfig: { QueryStringBehavior: "all" },
          CookiesConfig: { CookieBehavior: "all" },
          HeadersConfig: { HeaderBehavior: "whitelist", Headers: { Items: ["Origin", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Protocol", "Sec-WebSocket-Accept", "Sec-WebSocket-Extensions"] } },
        },
      },
    },
    [HOST_EVIDENCE_FILES.logGroups]: { logGroups: [{ logGroupName: `/gs/${ENV}/host`, retentionInDays: 90, logGroupClass: "STANDARD" }] },
    [HOST_EVIDENCE_FILES.containerInsightsLogGroups]: { logGroups: [] },
    [HOST_EVIDENCE_FILES.alarms]: alarms(),
    [HOST_EVIDENCE_FILES.budgets]: { Budgets: [{ BudgetName: `gs-${ENV}-monthly-ceiling`, BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: "30.0", Unit: "USD" } }] },
    [HOST_EVIDENCE_FILES.ecsClusters]: { clusters: [], failures: [{ arn: `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/gs-${ENV}`, reason: "MISSING" }] },
    [HOST_EVIDENCE_FILES.loadBalancers]: { LoadBalancers: [{ LoadBalancerName: "other-workload-alb" }] },
    [HOST_EVIDENCE_FILES.targetGroups]: { TargetGroups: [] },
    [HOST_EVIDENCE_FILES.hostHealth]: { InstanceId: ID, DocumentName: "AWS-RunShellScript", Status: "Success", ExecutionEndDateTime: iso(NOW - 30_000), StandardOutputContent: `${healthLine()}\n` },
    [HOST_EVIDENCE_FILES.runtimeSnapshot]: snapshot(),
  };
}

/** The same deployment mid-migration: the ECS era still exists, DRAINED (services at 0, no task, no target). */
function coexistFiles(): Files {
  const files = finalFiles();
  files[HOST_EVIDENCE_FILES.ecsClusters] = { clusters: [{ clusterName: `gs-${ENV}`, status: "ACTIVE" }], failures: [] };
  files[HOST_EVIDENCE_FILES.ecsServices] = {
    services: ["p1", "p2"].map((p) => ({ serviceName: `gs-${ENV}-${p}`, status: "ACTIVE", desiredCount: 0, runningCount: 0, pendingCount: 0 })),
    failures: [],
  };
  files[HOST_EVIDENCE_FILES.ecsRunningTasks] = { taskArns: [] };
  files[HOST_EVIDENCE_FILES.loadBalancers] = { LoadBalancers: [{ LoadBalancerName: `gs-${ENV}-alb` }, { LoadBalancerName: "other-workload-alb" }] };
  files[HOST_EVIDENCE_FILES.targetGroups] = { TargetGroups: [{ TargetGroupName: `gs-${ENV}-p1` }, { TargetGroupName: `gs-${ENV}-p2` }] };
  files[HOST_EVIDENCE_FILES.targetHealth(`gs-${ENV}-p1`)] = { TargetHealthDescriptions: [] };
  files[HOST_EVIDENCE_FILES.targetHealth(`gs-${ENV}-p2`)] = { TargetHealthDescriptions: [] };
  files[HOST_EVIDENCE_FILES.natGateways] = { NatGateways: [{ NatGatewayId: "nat-0123456789abcdef0", VpcId: VPC, State: "available" }] };
  files[HOST_EVIDENCE_FILES.vpcEndpoints] = { VpcEndpoints: [{ VpcEndpointId: "vpce-0123456789abcdef0", VpcId: VPC, VpcEndpointType: "Interface", ServiceName: `com.amazonaws.${REGION}.kms`, State: "available", Tags: [tag("gs:environment", ENV)] }] };
  files[HOST_EVIDENCE_FILES.alarms] = alarms(ID, [L6_ALARM]);
  files[HOST_EVIDENCE_FILES.logGroups] = { logGroups: [{ logGroupName: `/gs/${ENV}/host`, retentionInDays: 90, logGroupClass: "STANDARD" }, { logGroupName: `/gs/${ENV}/p1`, retentionInDays: 30 }, { logGroupName: `/gs/${ENV}/p2`, retentionInDays: 30 }] };
  files[HOST_EVIDENCE_FILES.securityGroups] = { SecurityGroups: [hostGroup(), { GroupName: `gs-${ENV}-task`, GroupId: "sg-0bbbbbbbbbbbbbbb2", VpcId: VPC, IpPermissions: [perm("tcp", 8917, 8917, { groups: ["sg-0ccccccccccccccc3"] })] }] };
  files[HOST_EVIDENCE_FILES.distributionConfig] = withGsOrigin(files, ALB_ORIGIN);
  files[HOST_EVIDENCE_FILES.runtimeSnapshot] = snapshot({ routes: ["p1", "p2"] });
  return files;
}

function withGsOrigin(files: Files, domain: string): Json {
  const dist = JSON.parse(JSON.stringify(files[HOST_EVIDENCE_FILES.distributionConfig])) as { DistributionConfig: { Origins: { Items: Array<{ Id: string; DomainName: string }> } } };
  for (const o of dist.DistributionConfig.Origins.Items) if (o.Id === "gs-alb") o.DomainName = domain;
  return dist;
}

/** Writes a capture: every file whole, the manifest last; `null` writes the capture's error file instead. */
function writeCapture(files: Files, over: Record<string, Json | null> = {}, manifest: Record<string, Json> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cost2a-"));
  const all: Record<string, Json | null> = { ...files, ...over };
  const calls: Array<{ file: string; ok: boolean }> = [];
  for (const [file, value] of Object.entries(all)) {
    if (value === undefined) continue;
    if (value === null) {
      fs.writeFileSync(path.join(dir, file.replace(/\.json$/, ".error.json")), JSON.stringify({ error: "An error occurred (AccessDenied) when calling the operation: not authorized", exit: 254 }));
      calls.push({ file, ok: false });
    } else {
      fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
      if (file !== HOST_EVIDENCE_FILES.runtimeSnapshot) calls.push({ file, ok: true });
    }
  }
  fs.writeFileSync(
    path.join(dir, HOST_EVIDENCE_FILES.manifest),
    JSON.stringify({ format: HOST_EVIDENCE_FORMAT, captured_at: iso(NOW - 60_000), finished_at: iso(NOW - 50_000), environment: ENV, region: REGION, account: ACCOUNT, caller_arn: `arn:aws:sts::${ACCOUNT}:assumed-role/gs-${ENV}-bootstrap/operator`, instance_id: ID, distribution: "E123ABC456", host_status: "captured", source_commit: "0".repeat(40), source_dirty: false, calls, ...manifest }),
  );
  return dir;
}

function expectFor(topology: HostExpect["topology"], over: Partial<HostExpect> = {}): HostExpect {
  return {
    topology,
    environment: ENV,
    region: REGION,
    account: ACCOUNT,
    pool: "p1",
    generation: 1,
    instanceId: ID,
    originHostname: ORIGIN,
    gsOrigin: topology === "coexist" ? ALB_ORIGIN : ORIGIN,
    siteOrigin: SITE,
    instanceType: null,
    emergencySsh: false,
    junoEgressPorts: [],
    budget: "required",
    expectDigest: DIGEST,
    expectBuild: BUILD,
    allowNatGateways: [],
    allowVpcEndpoints: [],
    allowEips: [],
    legacyVpcs: [],
    legacyPools: ["p1", "p2"],
    alarmActions: [],
    authorities: {
      gameTableArns: [`arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/gs-${ENV}-game-g1`],
      identityTableArn: `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/gs-${ENV}-identity`,
      ledgerTableArn: LEDGER_ARN,
      runtimeParameterArn: RUNTIME_ARN,
      junoParameterArn: JUNO_ARN,
      kmsKeyArns: KEYS,
    },
    relayer: { address: RELAYER, queue: { state: "empty" } },
    now: NOW,
    maxAgeMs: 30 * 60_000,
    ...over,
  };
}

function judged(files: Files, over: Record<string, Json | null> = {}, expect: HostExpect = expectFor("single-host"), manifest: Record<string, Json> = {}): HostCheck[] {
  const dir = writeCapture(files, over, manifest);
  try {
    return checkHostEvidenceDirectory(dir, expect, { escrow: expect.relayer !== null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const show = (checks: readonly HostCheck[]) => JSON.stringify(checks.filter((c) => c.status === "fail" || c.status === "not-evaluated"), null, 2);
function assertPass(checks: readonly HostCheck[]): void {
  assert.equal(verdictOf(checks), "PASS", show(checks));
}
function assertFail(checks: readonly HostCheck[], name: RegExp, why: string): void {
  assert.equal(verdictOf(checks), "FAIL", `${why}: ${show(checks)}`);
  assert.ok(checks.some((c) => c.status === "fail" && name.test(c.name)), `${why}: expected a FAIL named ${name}; got ${show(checks)}`);
}
function assertNotEvaluated(checks: readonly HostCheck[], name: RegExp, why: string): void {
  assert.notEqual(verdictOf(checks), "PASS", `${why}: never PASS`);
  assert.ok(checks.some((c) => c.status === "not-evaluated" && name.test(c.name)), `${why}: expected NOT EVALUATED for ${name}; got ${show(checks)}`);
  assert.ok(!checks.some((c) => c.status === "pass" && name.test(c.name)), `${why}: ${name} must not also pass`);
}

/* ================================================================== */
/* §1 The good states, and the mode boundary                            */
/* ================================================================== */

describe("COST-2A §1: the good final state, the good coexistence, and what separates them", () => {
  test("a complete, healthy final-state capture PASSES every check (and nothing is left unevaluated)", () => {
    const checks = judged(finalFiles());
    assertPass(checks);
    for (const area of ["EC2: exactly one host", "EC2: CPU credits standard", "EC2: IMDSv2 required, hop limit 2", "EC2: encrypted root volume", "EC2: termination protection", "network: exactly one host EIP", "security group: 443 from CloudFront only", "IAM: the host policy is limited to the configured authorities", "IAM: KMS keys = the runtime Juno configuration's", "host: SSM managed and online", "host: release digest", "host: HOLD", "edge: /gs* origin", "observability: exactly five host alarms", "observability: the monthly budget", "absent: ECS cluster and services", "absent: load balancers and target groups", "absent: NAT gateways", "absent: interface VPC endpoints", "absent: the L6-5B alarm matrix", "roles: identity writer held by the pool writer", "roles: relayer held by the pool writer", "money games: RELAYQ"]) {
      assert.equal(checks.find((c) => c.name === area)?.status, "pass", `${area}: ${JSON.stringify(checks.find((c) => c.name === area))}`);
    }
  });

  test("coexistence with the ECS era DRAINED (services 0/0/0, no task, ALB with no target, NAT, endpoints, L6 alarms) is allowed", () => {
    const checks = judged(coexistFiles(), {}, expectFor("coexist"));
    assertPass(checks);
    assert.equal(checks.find((c) => c.name === "ECS drained: no second serving writer")?.status, "pass");
    assert.equal(checks.find((c) => c.name === "ALB drained: no target registered")?.status, "pass");
    assert.equal(checks.find((c) => c.name === "coexistence: NAT gateways")?.status, "skipped", "tolerated and NAMED, never silently passed");
  });

  test("the SAME coexistence capture judged as the final state FAILS on every forgotten fixed-cost resource", () => {
    const checks = judged(coexistFiles(), {}, expectFor("single-host", { gsOrigin: ALB_ORIGIN }));
    for (const name of [/absent: ECS cluster/, /absent: load balancers and target groups/, /absent: NAT gateways/, /absent: interface VPC endpoints/, /absent: the L6-5B alarm matrix/, /observability: one host log group/, /absent: the ECS era's security groups/]) assertFail(checks, name, `final state: ${name}`);
  });

  test("final state: a forgotten ALB alone, a NAT alone, an interface endpoint alone -- each is a hard FAIL; a named other workload's is not", () => {
    const f = finalFiles();
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.loadBalancers]: { LoadBalancers: [{ LoadBalancerName: `gs-${ENV}-alb` }] } }), /absent: load balancers/, "forgotten ALB");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.targetGroups]: { TargetGroups: [{ TargetGroupName: `gs-${ENV}-p2` }] } }), /absent: load balancers and target groups/, "forgotten target group");
    const nat = { NatGateways: [{ NatGatewayId: "nat-0123456789abcdef0", VpcId: VPC, State: "available" }] };
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.natGateways]: nat }), /absent: NAT gateways/, "forgotten NAT");
    assertPass(judged(f, { [HOST_EVIDENCE_FILES.natGateways]: nat }, expectFor("single-host", { allowNatGateways: ["nat-0123456789abcdef0"] })));
    assertPass(judged(f, { [HOST_EVIDENCE_FILES.natGateways]: { NatGateways: [{ NatGatewayId: "nat-0123456789abcdef0", VpcId: VPC, State: "deleted" }] } }));
    const endpoint = { VpcEndpoints: [{ VpcEndpointId: "vpce-0123456789abcdef0", VpcId: VPC, VpcEndpointType: "Interface", ServiceName: `com.amazonaws.${REGION}.ssm`, State: "available" }] };
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.vpcEndpoints]: endpoint }), /absent: interface VPC endpoints/, "forgotten interface endpoint");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.vpcEndpoints]: { VpcEndpoints: [{ VpcEndpointId: "vpce-0aaaaaaaaaaaaaaa2", VpcId: VPC, VpcEndpointType: "Gateway", ServiceName: `com.amazonaws.${REGION}.dynamodb`, State: "available", Tags: [tag("gs:environment", ENV)] }] } }), /absent: interface VPC endpoints/, "the environment's own gateway endpoint");
    assertPass(judged(f, { [HOST_EVIDENCE_FILES.vpcEndpoints]: { VpcEndpoints: [{ VpcEndpointId: "vpce-0aaaaaaaaaaaaaaa3", VpcId: "vpc-0fffffffffffffff9", VpcEndpointType: "Interface", ServiceName: "x", State: "available" }] } }));
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.ecsClusters]: { clusters: [{ clusterName: `gs-${ENV}`, status: "ACTIVE" }], failures: [] } }), /absent: ECS cluster/, "an empty but ACTIVE cluster is still the ECS era");
    assertPass(judged(f, { [HOST_EVIDENCE_FILES.ecsClusters]: { clusters: [{ clusterName: `gs-${ENV}`, status: "INACTIVE" }], failures: [] } }));
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.alarms]: alarms(ID, [L6_ALARM]) }), /absent: the L6-5B alarm matrix/, "an obsolete L6 alarm");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.logGroups]: { logGroups: [{ logGroupName: `/gs/${ENV}/host`, retentionInDays: 90 }, { logGroupName: `/gs/${ENV}/p1`, retentionInDays: 30 }] } }), /one host log group/, "a pool log group left behind");
    const secondEip = (finalFiles()[HOST_EVIDENCE_FILES.addresses] as { Addresses: Json[] }).Addresses.concat([{ PublicIp: "198.51.100.8", Tags: [tag("gs:environment", ENV)] }]);
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.addresses]: { Addresses: secondEip } }), /absent: no second EIP/, "a stray environment EIP");
  });

  test("coexistence before the host exists (--instance-id none): a host that does exist is refused; none is verified as absent", () => {
    const f = coexistFiles();
    const none = expectFor("coexist", { instanceId: null, originHostname: null });
    const present = judged(f, {}, none, { instance_id: "none" });
    assertFail(present, /EC2: no host yet/, "an unnamed host is never silently skipped");
    const absent = judged(f, { [HOST_EVIDENCE_FILES.instances]: { Reservations: [] }, [HOST_EVIDENCE_FILES.instancesByProfile]: { Reservations: [] }, [HOST_EVIDENCE_FILES.hostHealth]: undefined, [HOST_EVIDENCE_FILES.logGroups]: { logGroups: [{ logGroupName: `/gs/${ENV}/p1` }] }, [HOST_EVIDENCE_FILES.budgets]: { Budgets: [] }, [HOST_EVIDENCE_FILES.alarms]: alarms(ID, [L6_ALARM]), [HOST_EVIDENCE_FILES.addresses]: { Addresses: [] } }, none, { instance_id: "none" });
    assert.equal(absent.find((c) => c.name === "EC2: no host yet (--instance-id none)")?.status, "pass");
    assert.equal(verdictOf(absent), "PASS", `before step D (no host log group, no budget yet) coexistence verifies: ${show(absent)}`);
    assert.ok(absent.some((c) => c.name === "host: network, IAM, health" && c.status === "skipped"));
  });
});

/* ================================================================== */
/* §2 The required negatives                                           */
/* ================================================================== */

describe("COST-2A §2: every required negative case FAILS", () => {
  const f = finalFiles();
  const withInstance = (over: Record<string, Json>, extra: Json[] = []) => {
    const listing = { Reservations: [{ Instances: [hostInstance(over), ...extra] }] };
    return { [HOST_EVIDENCE_FILES.instances]: listing, [HOST_EVIDENCE_FILES.instancesByProfile]: listing };
  };

  test("two hosts -- also an UNTAGGED instance holding the host role's profile (tags can be removed; the role's authority cannot)", () => {
    const rogue = hostInstance({ InstanceId: "i-0fedcba9876543210", Tags: [], PublicIpAddress: "198.51.100.9" });
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.instancesByProfile]: { Reservations: [{ Instances: [hostInstance(), rogue] }] } }), /EC2: exactly one host/, "an untagged instance with the host profile");
    assertNotEvaluated(judged(f, { [HOST_EVIDENCE_FILES.instancesByProfile]: null }), /EC2: exactly one host/, "the profile listing failed: a second holder cannot be ruled out");
    assertFail(judged(f, withInstance({}, [hostInstance({ InstanceId: "i-0fedcba9876543210", PublicIpAddress: "198.51.100.9" })])), /EC2: exactly one host/, "a second single-host instance");
    assertFail(judged(f, withInstance({}, [hostInstance({ InstanceId: "i-0fedcba9876543210", State: { Name: "stopped" } })])), /EC2: exactly one host/, "a STOPPED second host is still a second host");
    assertPass(judged(f, withInstance({}, [hostInstance({ InstanceId: "i-0fedcba9876543210", State: { Name: "terminated" } })])));
    assertFail(judged(f, withInstance({ InstanceId: "i-0fedcba9876543210" })), /EC2: exactly one host/, "another instance than the one named");
  });

  test("wrong instance type (and an architecture that does not match it)", () => {
    assertFail(judged(f, withInstance({ InstanceType: "m5.large", Architecture: "x86_64" })), /EC2: instance type/, "outside the budget's types");
    assertFail(judged(f, withInstance({ InstanceType: "t4g.medium" })), /EC2: instance type/, "t4g.medium is not allowed");
    assertFail(judged(f, {}, expectFor("single-host", { instanceType: "t4g.micro" })), /EC2: instance type/, "not the type the operator named");
    assertFail(judged(f, withInstance({ InstanceType: "t3.small" })), /EC2: architecture/, "t3 is x86_64: an arm64 instance / AMI does not match");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.image]: { Images: [{ ImageId: AMI, Architecture: "x86_64" }] } }), /EC2: architecture/, "an x86 AMI on a Graviton host");
  });

  test("unlimited CPU credits", () => {
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.creditSpecification]: { InstanceCreditSpecifications: [{ InstanceId: ID, CpuCredits: "unlimited" }] } }), /CPU credits standard/, "unlimited");
  });

  test("IMDSv1 allowed (and the other metadata hardening)", () => {
    const md = (over: Record<string, Json>) => withInstance({ MetadataOptions: { HttpTokens: "required", HttpPutResponseHopLimit: 2, HttpEndpoint: "enabled", HttpProtocolIpv6: "disabled", InstanceMetadataTags: "disabled", ...over } });
    assertFail(judged(f, md({ HttpTokens: "optional" })), /IMDSv2 required/, "IMDSv1 allowed");
    assertFail(judged(f, md({ HttpPutResponseHopLimit: 1 })), /IMDSv2 required/, "hop limit 1 (the container cannot reach the role)");
    assertFail(judged(f, md({ HttpPutResponseHopLimit: 3 })), /IMDSv2 required/, "hop limit 3");
    assertFail(judged(f, withInstance({ MetadataOptions: undefined })), /IMDSv2 required/, "no metadata options at all");
  });

  test("public 8917 (any rule reaching it, however wide)", () => {
    for (const rule of [perm("tcp", 8917, 8917, { cidrs: ["0.0.0.0/0"] }), perm("tcp", 0, 65535, { cidrs: ["10.0.0.0/8"] }), perm("-1", -1, -1, { cidrs: ["0.0.0.0/0"] })]) {
      assertFail(judged(f, { [HOST_EVIDENCE_FILES.securityGroups]: { SecurityGroups: [hostGroup([...HOST_INGRESS, rule])] } }), /no public 8917/, `rule ${JSON.stringify(rule).slice(0, 80)}`);
    }
  });

  test("unexpected SSH -- only --emergency-ssh accepts it, and only as at most two /32 addresses on port 22", () => {
    const ssh = (cidrs: string[]) => ({ [HOST_EVIDENCE_FILES.securityGroups]: { SecurityGroups: [hostGroup([...HOST_INGRESS, perm("tcp", 22, 22, { cidrs })])] } });
    assertFail(judged(f, ssh(["198.51.100.20/32"])), /security group: no SSH/, "SSH without emergency mode");
    assertPass(judged(f, ssh(["198.51.100.20/32"]), expectFor("single-host", { emergencySsh: true })));
    assertFail(judged(f, ssh(["0.0.0.0/0"]), expectFor("single-host", { emergencySsh: true })), /emergency SSH only/, "SSH from anywhere, even in emergency mode");
    assertFail(judged(f, ssh(["198.51.100.20/32", "198.51.100.21/32", "198.51.100.22/32"]), expectFor("single-host", { emergencySsh: true })), /emergency SSH only/, "three addresses");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.securityGroups]: { SecurityGroups: [hostGroup([perm("tcp", 443, 443, { cidrs: ["0.0.0.0/0"] }), HOST_INGRESS[1]])] } }), /443 from CloudFront only/, "443 from anywhere bypasses CloudFront");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.securityGroups]: { SecurityGroups: [hostGroup([...HOST_INGRESS, perm("tcp", 3306, 3306, { cidrs: ["0.0.0.0/0"] })])] } }), /no other ingress/, "any other port");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.securityGroups]: { SecurityGroups: [hostGroup(HOST_INGRESS, [perm("-1", -1, -1, { cidrs: ["0.0.0.0/0"] })])] } }), /security group: egress/, "all-traffic egress");
  });

  test("wrong EIP", () => {
    const eip = (over: Record<string, Json>) => ({ [HOST_EVIDENCE_FILES.addresses]: { Addresses: [{ PublicIp: IP, AllocationId: "eipalloc-0123456789abcdef0", NetworkInterfaceId: ENI, Domain: "vpc", Tags: [tag("gs:environment", ENV), tag("gs:component", "single-host")], ...over }] } });
    assertFail(judged(f, eip({ NetworkInterfaceId: "eni-0ffffffffffffffff" })), /exactly one host EIP/, "the EIP is on another ENI");
    assertFail(judged(f, eip({ NetworkInterfaceId: undefined })), /exactly one host EIP/, "the EIP is not associated");
    assertFail(judged(f, eip({ PublicIp: "198.51.100.99" })), /exactly one host EIP/, "the host does not answer on the EIP");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.addresses]: { Addresses: [] } }), /exactly one host EIP/, "no EIP");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.terraformOutputs]: { public_ip: { value: "198.51.100.99" }, instance_id: { value: ID } } }), /exactly one host EIP|Terraform outputs/, "Terraform names another address");
  });

  test("wrong CloudFront origin (and the frontend's origin, the request policy, the query strings)", () => {
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.distributionConfig]: withGsOrigin(f, ALB_ORIGIN) }), /edge: \/gs\* origin/, "the final state still points /gs* at the ALB");
    assertFail(judged(coexistFiles(), { [HOST_EVIDENCE_FILES.distributionConfig]: withGsOrigin(f, ORIGIN) }, expectFor("coexist")), /edge: \/gs\* origin/, "coexistence before step G expects the ALB's origin");
    assertPass(judged(coexistFiles(), { [HOST_EVIDENCE_FILES.distributionConfig]: withGsOrigin(f, ORIGIN) }, expectFor("coexist", { gsOrigin: ORIGIN })));
    const dist = JSON.parse(JSON.stringify(f[HOST_EVIDENCE_FILES.distributionConfig])) as { DistributionConfig: { DefaultCacheBehavior: { TargetOriginId: string } } };
    dist.DistributionConfig.DefaultCacheBehavior.TargetOriginId = "gs-alb";
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.distributionConfig]: dist }), /default frontend origin unchanged/, "the default behaviour sent to the game server");
    assertFail(judged(f, {}, expectFor("single-host", { siteOrigin: "other-site.example.org" })), /default frontend origin unchanged/, "the frontend's origin changed");
    assertNotEvaluated(judged(f, {}, expectFor("single-host", { siteOrigin: null })), /default frontend origin unchanged/, "not stated -> not evaluated");
    const orp = JSON.parse(JSON.stringify(f[HOST_EVIDENCE_FILES.originRequestPolicy])) as { OriginRequestPolicy: { OriginRequestPolicyConfig: { QueryStringsConfig: Json; Name: string } } };
    orp.OriginRequestPolicy.OriginRequestPolicyConfig.QueryStringsConfig = { QueryStringBehavior: "whitelist", QueryStrings: { Items: ["cp", "cr", "cb"] } };
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.originRequestPolicy]: orp }), /ALL query strings/, "an allow-list of query strings (even cp, cr, cb)");
    const renamed = JSON.parse(JSON.stringify(f[HOST_EVIDENCE_FILES.originRequestPolicy])) as typeof orp;
    renamed.OriginRequestPolicy.OriginRequestPolicyConfig.Name = "someone-elses-policy";
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.originRequestPolicy]: renamed }), /request policy preserved/, "another request policy");
  });

  test("missing host role (no instance profile, an empty profile, another role, a widened trust)", () => {
    assertFail(judged(f, withInstance({ IamInstanceProfile: undefined })), /the host instance profile/, "no instance profile");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.instanceProfile]: { InstanceProfile: { Roles: [] } } }), /instance profile holds the host role/, "a profile without the role");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.instanceProfile]: { InstanceProfile: { Roles: [{ Arn: `arn:aws:iam::${ACCOUNT}:role/gs-${ENV}-app-task` }] } } }), /instance profile holds the host role/, "the ECS task role on the host");
    const trust = JSON.parse(fixture("host-assume-role-policy-staging.json")) as { Statement: Array<Record<string, Json>> };
    trust.Statement[0].Principal = { AWS: "*" };
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.role]: { Role: { Arn: `arn:aws:iam::${ACCOUNT}:role/gs-${ENV}-host-app`, AssumeRolePolicyDocument: trust } } }), /IAM: the host role/, "assumable by anyone");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.roleAttachedPolicies]: { AttachedPolicies: [{ PolicyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore" }] } }), /no managed policy/, "a managed policy reads every parameter");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.roleInlinePolicies]: { PolicyNames: ["gs-single-host-runtime", "debug"] } }), /one inline policy/, "a second inline policy");
  });

  test("wrong KMS allow-list (a stale, a missing or an extra key) and any widening of the host policy", () => {
    const policy = () => JSON.parse(fixture("host-role-policy-staging.json")) as { Statement: Array<Record<string, Json>> };
    const withPolicy = (doc: Json) => ({ [HOST_EVIDENCE_FILES.rolePolicy]: { RoleName: `gs-${ENV}-host-app`, PolicyDocument: doc } });
    const stale = `arn:aws:kms:${REGION}:222222222222:key/44444444-4444-4444-8444-444444444444`;
    assertFail(judged(f, {}, expectFor("single-host", { authorities: { ...expectFor("single-host").authorities, kmsKeyArns: [KEYS[0], KEYS[1], stale] } })), /KMS keys = the runtime Juno configuration's/, "the configuration rotated to a key the role cannot sign with");
    const missing = policy();
    for (const s of missing.Statement) if (String(s.Sid).startsWith("SigningKeys")) s.Resource = (s.Resource as string[]).filter((r) => r !== KEYS[2]);
    assertFail(judged(f, withPolicy(missing)), /KMS keys = the runtime Juno configuration's/, "a configured key the role cannot use");
    const extra = policy();
    for (const s of extra.Statement) if (String(s.Sid).startsWith("SigningKeys")) s.Resource = [...(s.Resource as string[]), stale];
    assertFail(judged(f, withPolicy(extra)), /limited to the configured authorities|KMS keys/, "an extra key");
    const noCondition = policy();
    for (const s of noCondition.Statement) if (s.Sid === "SigningKeysSignDigestOnly") delete s.Condition;
    assertFail(judged(f, withPolicy(noCondition)), /limited to the configured authorities/, "Sign without the DIGEST / ECDSA_SHA_256 condition");
    for (const [label, statement] of [
      ["iam:PassRole", { Sid: "X", Effect: "Allow", Action: "iam:PassRole", Resource: "*" }],
      ["a wildcard action", { Sid: "X", Effect: "Allow", Action: "dynamodb:*", Resource: expectFor("single-host").authorities.gameTableArns }],
      ["another table", { Sid: "X", Effect: "Allow", Action: "dynamodb:GetItem", Resource: `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/gs-prod-game-g1` }],
      ["Secrets Manager", { Sid: "X", Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: "*" }],
      ["every parameter", { Sid: "X", Effect: "Allow", Action: "ssm:GetParameter", Resource: `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/*` }],
      ["kms:CreateGrant", { Sid: "X", Effect: "Allow", Action: "kms:CreateGrant", Resource: KEYS }],
      ["NotAction", { Sid: "X", Effect: "Allow", NotAction: "iam:*", Resource: "*" }],
    ] as const) {
      const widened = policy();
      widened.Statement.push(statement as unknown as Record<string, Json>);
      assertFail(judged(f, withPolicy(widened)), /limited to the configured authorities|SSM documents|KMS keys/, label);
    }
    const systemWrite = policy();
    for (const s of systemWrite.Statement) if (s.Sid === "GameTableWriteNeverSystem") delete s.Condition;
    assertFail(judged(f, withPolicy(systemWrite)), /limited to the configured authorities/, "game-table writes reaching SYSTEM/*");
    const appgenWrite = policy();
    for (const s of appgenWrite.Statement) if (s.Sid === "LedgerAppendNeverAppgen") delete s.Condition;
    assertFail(judged(f, withPolicy(appgenWrite)), /limited to the configured authorities/, "ledger appends reaching APPGEN");
    /* No escrow: the role must not sign at all. */
    assertFail(judged(f, {}, expectFor("single-host", { authorities: { ...expectFor("single-host").authorities, kmsKeyArns: null, junoParameterArn: null }, relayer: null })), /KMS keys|SSM documents|limited to/, "keys granted without escrow");
  });

  test("an unexpected SECOND SERVING WRITER: ECS beside the host, a registered target, a role held by another task", () => {
    const c = coexistFiles();
    const co = expectFor("coexist");
    assertFail(judged(c, { [HOST_EVIDENCE_FILES.ecsRunningTasks]: { taskArns: [`arn:aws:ecs:${REGION}:${ACCOUNT}:task/gs-${ENV}/0123456789abcdef0123456789abcdef`] } }, co), /ECS drained: no second serving writer/, "an ECS task running");
    assertFail(judged(c, { [HOST_EVIDENCE_FILES.ecsServices]: { services: [{ serviceName: `gs-${ENV}-p1`, status: "ACTIVE", desiredCount: 1, runningCount: 0, pendingCount: 1 }] } }, co), /ECS drained/, "a service starting a task");
    assertFail(judged(c, { [HOST_EVIDENCE_FILES.targetHealth(`gs-${ENV}-p2`)]: { TargetHealthDescriptions: [{ Target: { Id: "10.0.0.5" }, TargetHealth: { State: "healthy" } }] } }, co), /ALB drained: no target registered/, "a registered target");
    assertFail(judged(finalFiles(), { [HOST_EVIDENCE_FILES.runtimeSnapshot]: snapshot({ identityTask: "t-fedcba9876543210" }) }), /identity writer held by the pool writer/, "the identity writer held by another task");
    assertFail(judged(finalFiles(), { [HOST_EVIDENCE_FILES.runtimeSnapshot]: snapshot({ relayerTask: "t-fedcba9876543210" }) }), /relayer held by the pool writer/, "the relayer held by another task");
    assertFail(judged(finalFiles(), { [HOST_EVIDENCE_FILES.runtimeSnapshot]: snapshot({ relayerConsistency: "minted-not-mirrored" }) }), /relayer held by the pool writer/, "a relayer takeover in flight");
    assertFail(judged(finalFiles(), { [HOST_EVIDENCE_FILES.runtimeSnapshot]: snapshot({ primary: "p2" }) }), /ROUTING primary is the host's pool/, "the routing names another pool");
  });

  test("the host itself: a HOLD, a digest or build that is not the reviewed one, a static credential, not ready", () => {
    const h = (over: Record<string, string>) => ({ [HOST_EVIDENCE_FILES.hostHealth]: { InstanceId: ID, Status: "Success", ExecutionEndDateTime: iso(NOW - 30_000), StandardOutputContent: `${healthLine(over)}\n` } });
    assertFail(judged(f, h({ hold: "exit 3 at 2026-10-02T17:00:00Z" })), /host: HOLD/, "on HOLD");
    assertFail(judged(f, h({ running_digest: `sha256:${"b".repeat(64)}` })), /host: release digest/, "a container not from the release");
    assertFail(judged(f, h({ digest: `sha256:${"c".repeat(64)}`, running_digest: `sha256:${"c".repeat(64)}` })), /host: release digest/, "not the reviewed release");
    assertFail(judged(f, h({ build: "b41" })), /host: build id/, "another build");
    assertFail(judged(f, h({ static_credentials: "AWS_ACCESS_KEY_ID" })), /no static credential/, "a static credential");
    assertFail(judged(f, h({ readyz: "503" })), /host: gs-health/, "not ready");
    assertFail(judged(f, h({ caddy: "failed" })), /gs-caddy/, "Caddy down");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.ssmInstance]: { InstanceInformationList: [{ InstanceId: ID, PingStatus: "ConnectionLost" }] } }), /SSM managed and online/, "SSM offline");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.hostHealth]: { InstanceId: "i-0fedcba9876543210", Status: "Success", ExecutionEndDateTime: iso(NOW - 30_000), StandardOutputContent: healthLine() } }), /host: gs-health/, "a status line from another host");
    assertNotEvaluated(judged(f, {}, expectFor("single-host", { expectDigest: null })), /host: release digest/, "no reviewed digest named -> not evaluated");
  });

  test("the rest of the host's properties: termination protection, encryption, a key pair, monitoring, alarms, budget", () => {
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.terminationProtection]: { InstanceId: ID, DisableApiTermination: { Value: false } } }), /termination protection/, "off");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.volumes]: { Volumes: [{ VolumeId: VOL, Encrypted: false }] } }), /encrypted root volume/, "unencrypted root");
    assertFail(judged(f, withInstance({ KeyName: "ops" })), /no key pair/, "an SSH key pair");
    assertFail(judged(f, withInstance({ Monitoring: { State: "enabled" } })), /detailed monitoring off/, "detailed monitoring");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.alarms]: alarms("i-0fedcba9876543210") }), /exactly five host alarms/, "alarms watching a replaced host");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.alarms]: alarms(ID, [], (a) => (a.MetricName === "HostHealthProblems" ? { ...a, TreatMissingData: "notBreaching" } : a)) }), /exactly five host alarms/, "a dead server would not page");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.alarms]: alarms(ID, [], (a) => ({ ...a, ActionsEnabled: false })) }), /exactly five host alarms/, "muted");
    const four = alarms() as { MetricAlarms: Json[] };
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.alarms]: { MetricAlarms: four.MetricAlarms.slice(1), CompositeAlarms: [] } }), /exactly five host alarms/, "four alarms");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.budgets]: { Budgets: [] } }), /the monthly budget/, "no budget");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.budgets]: { Budgets: [{ BudgetName: `gs-${ENV}-monthly-ceiling`, BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: "30.01", Unit: "USD" } }] } }), /the monthly budget/, "above the $30 ceiling");
    assert.ok(judged(f, { [HOST_EVIDENCE_FILES.budgets]: null }, expectFor("single-host", { budget: "not-required" })).some((c) => c.name === "observability: the monthly budget" && c.status === "skipped"), "a budget in the payer account is named out of scope");
    assert.equal(usdCents("30.0"), 3000);
    assert.equal(usdCents("29.999"), 3000, "a sub-cent remainder rounds UP (never under the ceiling by rounding)");
    assert.equal(usdCents("30.001"), 3001);
  });

  test("evidence for another deployment, or too old, never certifies this one", () => {
    assertFail(judged(f, {}, expectFor("single-host"), { environment: "prod" }), /host evidence manifest$/, "another environment");
    assertFail(judged(f, {}, expectFor("single-host"), { account: "999999999999" }), /manifest: account/, "another account");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.callerIdentity]: { Account: "999999999999", Arn: "arn:aws:sts::999999999999:assumed-role/x/y" } }), /the capture's identity/, "a manifest whose account the capture's own STS answer contradicts");
    assertFail(judged(f, {}, expectFor("single-host"), { captured_at: iso(NOW - 2 * 3_600_000) }), /manifest: fresh/, "two hours old");
    assertFail(judged(f, {}, expectFor("single-host"), { captured_at: iso(NOW + 3_600_000) }), /manifest: fresh/, "from the future");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.runtimeSnapshot]: { ...(snapshot() as Record<string, Json>), captured_at: iso(NOW - 2 * 3_600_000) } }), /runtime snapshot fresh/, "a stale snapshot");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.runtimeSnapshot]: snapshot({ generation: 2 }) }), /the runtime snapshot$/, "another generation's snapshot");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.hostHealth]: { InstanceId: ID, Status: "Success", ExecutionEndDateTime: iso(NOW - 2 * 3_600_000), StandardOutputContent: healthLine() } }), /gs-health fresh/, "a stale host line");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.runtimeSnapshot]: snapshot({ money: { source: "open-money", games: [{ game_id: "g1", owner: "orphaned" }], problems: [] } }) }), /open money games settled/, "an orphaned money game");
  });

  test("the ingress judge on its own: every rule shape that reaches 22 or 8917 is caught", () => {
    const base = HOST_INGRESS.map((p) => ({ protocol: p.IpProtocol, from: p.FromPort, to: p.ToPort, cidrs: p.IpRanges.map((r) => r.CidrIp), cidrs6: [], prefixLists: p.PrefixListIds.map((r) => r.PrefixListId), groups: [] }));
    const fails = (extra: { protocol: string; from: number | null; to: number | null; cidrs: string[] }) => judgeHostIngress([...base, { ...extra, cidrs6: [], prefixLists: [], groups: [] }], { cloudFrontPrefixList: PL, emergencySsh: false, serverPort: 8917 }).filter((c) => c.status === "fail").map((c) => c.name);
    assert.deepEqual(fails({ protocol: "tcp", from: 22, to: 22, cidrs: ["1.2.3.4/32"] }), ["security group: no SSH"]);
    assert.ok(fails({ protocol: "tcp", from: 1, to: 1024, cidrs: ["1.2.3.4/32"] }).includes("security group: no SSH"));
    assert.ok(fails({ protocol: "6", from: 8000, to: 9000, cidrs: ["1.2.3.4/32"] }).includes("security group: no public 8917"));
    assert.ok(fails({ protocol: "-1", from: null, to: null, cidrs: ["0.0.0.0/0"] }).includes("security group: no public 8917"));
  });
});

/* ================================================================== */
/* §2b The independent review's findings, each pinned                   */
/* ================================================================== */

describe("COST-2A §2b: the review's findings (stale files, muted alarms, the edge-to-host chain, mode and scope gaps)", () => {
  const f = finalFiles();

  test("H1: a file an EARLIER capture left (not in this manifest's calls) is never judged -- a stale drained ECS answer cannot pass", () => {
    const c = coexistFiles();
    /* This run: the cluster DEPROVISIONING and its services / tasks NOT captured; last run's drained answers still lie there. */
    const dir = writeCapture({ ...c, [HOST_EVIDENCE_FILES.ecsClusters]: { clusters: [{ clusterName: `gs-${ENV}`, status: "DEPROVISIONING" }], failures: [] } });
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, HOST_EVIDENCE_FILES.manifest), "utf8")) as { calls: Array<{ file: string }> };
      manifest.calls = manifest.calls.filter((x) => x.file !== HOST_EVIDENCE_FILES.ecsServices && x.file !== HOST_EVIDENCE_FILES.ecsRunningTasks);
      fs.writeFileSync(path.join(dir, HOST_EVIDENCE_FILES.manifest), JSON.stringify(manifest));
      assertNotEvaluated(checkHostEvidenceDirectory(dir, expectFor("coexist"), { escrow: true }), /ECS drained/, "stale services / tasks files");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("H2: whom the alarms notify is stated or NOT EVALUATED -- an alarm with no destination is never silently a pass", () => {
    assertNotEvaluated(judged(f, {}, expectFor("single-host", { alarmActions: null })), /exactly five host alarms/, "no --alarm-actions");
    assertPass(judged(f, {}, expectFor("single-host", { alarmActions: [] })));
    const topic = `arn:aws:sns:${REGION}:${ACCOUNT}:gs-pages`;
    assertFail(judged(f, {}, expectFor("single-host", { alarmActions: [topic] })), /exactly five host alarms/, "pages go nowhere");
    assertPass(judged(f, { [HOST_EVIDENCE_FILES.alarms]: alarms(ID, [], (a) => ({ ...a, AlarmActions: [topic], OKActions: [topic] })) }, expectFor("single-host", { alarmActions: [topic] })));
  });

  test("M1: the host serves --origin-hostname (gs-health's own name); Terraform outputs that were asked for but are unreadable are NOT EVALUATED", () => {
    const h = (over: Record<string, string>) => ({ [HOST_EVIDENCE_FILES.hostHealth]: { InstanceId: ID, Status: "Success", ExecutionEndDateTime: iso(NOW - 30_000), StandardOutputContent: `${healthLine(over)}\n` } });
    assertFail(judged(f, h({ origin_hostname: "another-origin.example.org" })), /its origin is --origin-hostname/, "CloudFront and the operator agree on a name the host does not serve");
    assertFail(judged(f, h({ origin_hostname: "" })), /its origin is --origin-hostname/, "an older gs-health");
    const dir = writeCapture(f);
    try {
      fs.writeFileSync(path.join(dir, HOST_EVIDENCE_FILES.terraformOutputs), "Warning: something\n{ not json");
      const m = JSON.parse(fs.readFileSync(path.join(dir, HOST_EVIDENCE_FILES.manifest), "utf8")) as { calls: Array<{ file: string; ok: boolean }> };
      m.calls.push({ file: HOST_EVIDENCE_FILES.terraformOutputs, ok: true });
      fs.writeFileSync(path.join(dir, HOST_EVIDENCE_FILES.manifest), JSON.stringify(m));
      assertNotEvaluated(checkHostEvidenceDirectory(dir, expectFor("single-host"), { escrow: true }), /Terraform outputs/, "unreadable outputs");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(judged(f).find((c) => c.name === "Terraform outputs = what runs")?.status, "skipped", "not asked for: a named skip");
  });

  test("M5: an unassociated EIP, a NAT in the ECS era's VPC, Container Insights log groups -- each a final-state FAIL", () => {
    const eips = (f[HOST_EVIDENCE_FILES.addresses] as { Addresses: Json[] }).Addresses.concat([{ PublicIp: "198.51.100.30", AllocationId: "eipalloc-0aaaaaaaaaaaaaaa9", Domain: "vpc", Tags: [] }]);
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.addresses]: { Addresses: eips } }), /absent: no second EIP/, "a released NAT's EIP left allocated");
    assertPass(judged(f, { [HOST_EVIDENCE_FILES.addresses]: { Addresses: eips } }, expectFor("single-host", { allowEips: ["eipalloc-0aaaaaaaaaaaaaaa9"] })));
    assert.ok(judged(coexistFiles(), { [HOST_EVIDENCE_FILES.addresses]: { Addresses: eips } }, expectFor("coexist")).some((c) => c.name === "coexistence: no second EIP" && c.status === "skipped"));
    const nat = { NatGateways: [{ NatGatewayId: "nat-0bbbbbbbbbbbbbbb1", VpcId: "vpc-0eeeeeeeeeeeeeee1", State: "available" }] };
    assertPass(judged(f, { [HOST_EVIDENCE_FILES.natGateways]: nat }));
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.natGateways]: nat }, expectFor("single-host", { legacyVpcs: ["vpc-0eeeeeeeeeeeeeee1"] })), /absent: NAT gateways/, "a NAT in the ECS era's VPC");
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.containerInsightsLogGroups]: { logGroups: [{ logGroupName: `/aws/ecs/containerinsights/gs-${ENV}/performance` }] } }), /Container Insights/, "Container Insights left behind");
  });

  test("M6: another environment sharing the prefix (gs-staging-eu) is not this one's -- exact names, the alarm contract, the Environment dimension", () => {
    const other = {
      [HOST_EVIDENCE_FILES.loadBalancers]: { LoadBalancers: [{ LoadBalancerName: `gs-${ENV}-eu-alb` }] },
      [HOST_EVIDENCE_FILES.targetGroups]: { TargetGroups: [{ TargetGroupName: `gs-${ENV}-eu-p1` }] },
      [HOST_EVIDENCE_FILES.alarms]: alarms(ID, [
        { AlarmName: `gs-${ENV}-eu-host-status-check`, Namespace: "AWS/EC2", MetricName: "StatusCheckFailed", Dimensions: [{ Name: "InstanceId", Value: "i-0eeeeeeeeeeeeeee1" }], ActionsEnabled: true },
        { AlarmName: `gs-${ENV}-eu-p1-pool-lost`, Dimensions: [{ Name: "Environment", Value: `${ENV}-eu` }, { Name: "Pool", Value: "p1" }], ActionsEnabled: true },
      ]),
    };
    assertPass(judged(f, other));
    const composite = [...ecsEraAlarmNames(ENV, ["p1", "p2"])].find((n) => n.endsWith("-notify")) as string;
    const withComposite = { ...(alarms() as Record<string, Json>), CompositeAlarms: [{ AlarmName: composite, AlarmRule: "x" }] };
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.alarms]: withComposite }), /the L6-5B alarm matrix/, `this environment's own composite ${composite}`);
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.targetGroups]: { TargetGroups: [{ TargetGroupName: `gs-${ENV}-p3` }] } }, expectFor("single-host", { legacyPools: ["p1", "p2", "p3"] })), /absent: load balancers/, "a named legacy pool's target group");
  });

  test("L1: a policy whose Statement is ONE object (not a list) is judged like any other", () => {
    const doc = { Version: "2012-10-17", Statement: { Sid: "X", Effect: "Allow", Action: "*", Resource: "*" } };
    assertFail(judged(f, { [HOST_EVIDENCE_FILES.rolePolicy]: { RoleName: `gs-${ENV}-host-app`, PolicyDocument: doc } }), /limited to the configured authorities/, "Statement as an object");
  });
});

/* ================================================================== */
/* §3 A failed read is NOT EVALUATED -- never PASS                       */
/* ================================================================== */

describe("COST-2A §3: a read failure is NOT EVALUATED, never PASS", () => {
  test("EVERY evidence file, missing or written as the capture's error, leaves the verdict short of PASS (final state and coexistence)", () => {
    for (const [label, files, expect] of [
      ["single-host", finalFiles(), expectFor("single-host")],
      ["coexist", coexistFiles(), expectFor("coexist")],
    ] as const) {
      for (const file of Object.keys(files)) {
        for (const mode of ["missing", "error"] as const) {
          const over: Record<string, Json | null> = { [file]: mode === "missing" ? undefined : null };
          const dir = writeCapture(Object.fromEntries(Object.entries(files).filter(([k]) => mode === "error" || k !== file)), mode === "error" ? over : {});
          try {
            const checks = checkHostEvidenceDirectory(dir, expect, { escrow: true });
            assert.notEqual(verdictOf(checks), "PASS", `${label}: ${file} ${mode} must not PASS`);
            if (mode === "error") assert.ok(checks.some((c) => c.status === "not-evaluated"), `${label}: ${file} error -> something NOT EVALUATED`);
          } finally {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    }
  });

  test("an ABSENCE check never passes on a failed listing -- or on an answer without its list", () => {
    const f = finalFiles();
    for (const [file, name] of [
      [HOST_EVIDENCE_FILES.loadBalancers, /absent: load balancers/],
      [HOST_EVIDENCE_FILES.targetGroups, /absent: load balancers/],
      [HOST_EVIDENCE_FILES.ecsClusters, /absent: ECS cluster/],
      [HOST_EVIDENCE_FILES.natGateways, /absent: NAT gateways/],
      [HOST_EVIDENCE_FILES.vpcEndpoints, /absent: interface VPC endpoints/],
      [HOST_EVIDENCE_FILES.alarms, /absent: the L6-5B alarm matrix/],
      [HOST_EVIDENCE_FILES.instances, /EC2: exactly one host/],
    ] as const) {
      assertNotEvaluated(judged(f, { [file]: null }), name, `${file} failed`);
      assertNotEvaluated(judged(f, { [file]: {} }), name, `${file} answered without its list`);
    }
  });

  test("the manifest: missing -> not evaluated; a call recorded failed stays not evaluated until its answer exists", () => {
    const dir = writeCapture(finalFiles());
    try {
      fs.rmSync(path.join(dir, HOST_EVIDENCE_FILES.manifest));
      assertNotEvaluated(checkHostEvidenceDirectory(dir, expectFor("single-host"), { escrow: true }), /host evidence manifest/, "no manifest");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    /* --host-status-only after a failed first attempt: the manifest still says failed, the answer now exists. */
    const later = writeCapture(finalFiles());
    try {
      const m = JSON.parse(fs.readFileSync(path.join(later, HOST_EVIDENCE_FILES.manifest), "utf8")) as { calls: Array<{ file: string; ok: boolean }> };
      for (const c of m.calls) if (c.file === HOST_EVIDENCE_FILES.hostHealth) c.ok = false;
      fs.writeFileSync(path.join(later, HOST_EVIDENCE_FILES.manifest), JSON.stringify(m));
      assertPass(checkHostEvidenceDirectory(later, expectFor("single-host"), { escrow: true }));
    } finally {
      fs.rmSync(later, { recursive: true, force: true });
    }
    assertNotEvaluated(judged(finalFiles(), {}, expectFor("single-host"), { account: "" }), /manifest: account/, "the capture could not read its account");
    assertNotEvaluated(judged(finalFiles(), {}, expectFor("single-host"), { calls: undefined }), /every read succeeded/, "a manifest listing no reads (hand-made) is never trusted");
  });

  test("the host's status line not captured (no --host-status): every host check NOT EVALUATED, none passed", () => {
    const checks = judged(finalFiles(), { [HOST_EVIDENCE_FILES.hostHealth]: undefined });
    for (const name of [/host: gs-health/, /host: release digest/, /host: build id/, /host: HOLD/, /gs-server \/ gs-caddy/, /no static credential/]) assertNotEvaluated(checks, name, "no host status");
    assert.equal(verdictOf(checks), "NOT EVALUATED");
  });

  test("the runtime snapshot missing: the roles and money games NOT EVALUATED", () => {
    const checks = judged(finalFiles(), { [HOST_EVIDENCE_FILES.runtimeSnapshot]: undefined });
    for (const name of [/ROUTING primary/, /the pool writer/, /identity writer held/, /relayer held/, /open money games/]) assertNotEvaluated(checks, name, "no snapshot");
    assertNotEvaluated(judged(finalFiles(), {}, expectFor("single-host", { relayer: { address: RELAYER, queue: { state: "unknown", detail: "AccessDenied" } } })), /RELAYQ/, "an unread RELAYQ");
  });

  test("report(): NOT EVALUATED exits 3 and never prints VERIFIED; a FAIL wins; the ECS line is unchanged when nothing is unevaluated", () => {
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    const c = (status: Check["status"]): Check => ({ name: status, status, detail: "d" });
    assert.equal(report(out, [c("pass"), c("not-evaluated")]), EXIT_NOT_EVALUATED);
    assert.match(lines[lines.length - 1], /^NOT EVALUATED: 1 passed, 0 failed, 1 not evaluated, 0 skipped .* NOT a pass$/);
    assert.ok(!lines.some((l) => /^VERIFIED/.test(l)));
    assert.equal(report(out, [c("fail"), c("not-evaluated")]), EXIT_FAILED);
    assert.match(lines[lines.length - 1], /^NOT VERIFIED: /);
    assert.equal(report(out, [c("pass"), c("skipped")]), EXIT_OK);
    assert.equal(lines[lines.length - 1], "VERIFIED: 1 passed, 0 failed, 1 skipped (named above)");
    assert.equal(report(out, [c("pass"), c("fail")]), EXIT_FAILED);
    assert.equal(lines[lines.length - 1], "NOT VERIFIED: 1 passed, 1 failed, 0 skipped (named above)");
  });
});

/* ================================================================== */
/* §4 `awsDeploy verify --topology` end to end                           */
/* ================================================================== */

/** A DynamoDB that answers the verifier's reads -- the three tables, APPGEN, the routing and the generation marker -- with
 *  the items the bootstrap and L6-4 writers produce. */
function fakeDynamo(): DynamoDBClient {
  const table = (name: string) => ({ TableName: name, TableStatus: "ACTIVE", KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }], AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }], BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" }, DeletionProtectionEnabled: true });
  const nameOf = (t: string | undefined) => (t ?? "").replace(/^arn:.*:table\//, "");
  const items = new Map<string, Record<string, Json>>([
    [`gs-${ENV}-ledger|APPGEN|APPGEN`, appgenItem(1)],
    [`gs-${ENV}-game-g1|SYSTEM|ROUTING`, { pk: { S: "SYSTEM" }, sk: { S: "ROUTING" }, fmt: { N: "1" }, primary_pool: { S: "p1" }, routing_version: { N: "3" }, updated_at: { N: "0" }, updated_by: { S: "bootstrap" }, claim: { S: "c" } }],
    [`gs-${ENV}-game-g1|SYSTEM|GENERATION`, generationMarkerItem(bootstrapGenerationMarker({ generation: 1, gameTable: `gs-${ENV}-game-g1`, by: "test", now: 0 }))],
  ]);
  const client = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof DescribeTableCommand) return { Table: table(nameOf(command.input.TableName)) };
      if (command instanceof DescribeContinuousBackupsCommand) return { ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: "ENABLED" } } };
      if (command instanceof DescribeTimeToLiveCommand) return { TimeToLiveDescription: { TimeToLiveStatus: "ENABLED", AttributeName: "ttl" } };
      if (command instanceof GetItemCommand) {
        const key = command.input.Key as Record<string, { S?: string }>;
        return { Item: items.get(`${nameOf(command.input.TableName)}|${key.pk?.S}|${key.sk?.S}`) };
      }
      if (command instanceof QueryCommand) return { Items: [], Count: 0 };
      throw new Error(`the fake has no answer for ${(command as { constructor: { name: string } }).constructor.name}`);
    },
    destroy() {},
  };
  return client as unknown as DynamoDBClient;
}

function noEscrowFiles(): Files {
  const files = finalFiles();
  const policy = JSON.parse(fixture("host-role-policy-staging.json")) as { Statement: Array<Record<string, Json>> };
  policy.Statement = policy.Statement.filter((s) => !String(s.Sid).startsWith("SigningKeys"));
  for (const s of policy.Statement) if (s.Sid === "ReadRuntimeConfiguration") s.Resource = [RUNTIME_ARN];
  files[HOST_EVIDENCE_FILES.rolePolicy] = { RoleName: `gs-${ENV}-host-app`, PolicyName: "gs-single-host-runtime", PolicyDocument: policy };
  files[HOST_EVIDENCE_FILES.runtimeSnapshot] = snapshot({ escrow: false });
  return files;
}

function deps(lines: string[]): DeployDeps {
  const parameters: ParameterSource = {
    async read(arn) {
      if (arn !== RUNTIME_ARN) throw new Error(`no parameter ${arn}`);
      return { value: fixture("runtime-staging-p1-noescrow.json"), version: 3, arn };
    },
  };
  return {
    parameters,
    dynamo: () => fakeDynamo(),
    kms: () => {
      throw new Error("no escrow: the verifier reads no key");
    },
    now: () => NOW,
    out: (l) => lines.push(l),
  };
}

const VERIFY = (dir: string, extra: string[] = []) => ["verify", "--topology", "single-host", "--runtime-parameter", RUNTIME_ARN, "--environment", ENV, "--primary-pool", "p1", "--generation", "1", "--evidence", dir, "--instance-id", ID, "--origin-hostname", ORIGIN, "--site-origin", SITE, "--expect-digest", DIGEST, "--expect-build", BUILD, "--alarm-actions", "none", ...extra];

describe("COST-2A §4: awsDeploy verify --topology, end to end", () => {
  test("single-host PASS -> exit 0, the data plane (task's own parser, tables, APPGEN, routing, marker) beside the host's control plane; the record and the report", async () => {
    const dir = writeCapture(noEscrowFiles());
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "cost2a-report-"));
    const lines: string[] = [];
    try {
      const code = await runDeployCommand(VERIFY(dir, ["--record", path.join(out, "verify.json"), "--report", out]), deps(lines));
      assert.equal(code, EXIT_OK, lines.filter((l) => /^(FAIL|NOT EVALUATED|REFUSED)/.test(l)).join("\n"));
      assert.ok(lines.some((l) => /^PASS  runtime document p1 -- v3 parsed by the task's own code/.test(l)), "the data plane ran");
      assert.ok(lines.some((l) => /^PASS  SYSTEM\/GENERATION/.test(l)) && lines.some((l) => /^PASS  APPGEN/.test(l)) && lines.some((l) => /^PASS  game table: PITR/.test(l)));
      assert.ok(lines.some((l) => /^PASS  absent: load balancers and target groups/.test(l)), "the host control plane ran");
      assert.ok(lines.some((l) => /^SKIP  roles: relayer held by the pool writer -- no escrow/.test(l)));
      assert.match(lines[lines.length - 1], /^VERIFIED: /);
      const record = JSON.parse(fs.readFileSync(path.join(out, "verify.json"), "utf8")) as { verdict: string; topology: string };
      assert.equal(record.verdict, "PASS", "a host record's verdict is the run's: named skips (the ledger's PITR from the app account, no relayer) are not failures");
      assert.equal(record.topology, "single-host");
      const machine = JSON.parse(fs.readFileSync(path.join(out, "host-evidence.json"), "utf8")) as { format: string; verdict: string; facts: Record<string, Record<string, unknown> | null> };
      assert.equal(machine.format, HOST_REPORT_FORMAT);
      assert.equal(machine.verdict, "PASS");
      assert.equal(machine.facts.ec2?.instance_id, ID);
      assert.equal(machine.facts.eip?.public_ip, IP);
      assert.equal(machine.facts.cloudfront?.gs_origin, ORIGIN);
      assert.equal(machine.facts.host?.digest, DIGEST);
      assert.equal(machine.facts.source?.commit, "0".repeat(40));
      for (const area of ["source", "terraform", "ec2", "iam", "network", "eip", "cloudfront", "host", "generation", "roles", "alarms", "money", "relayq"]) assert.ok(area in machine.facts, area);
      const human = fs.readFileSync(path.join(out, "host-evidence.md"), "utf8");
      assert.match(human, /\*\*Verdict: PASS\*\*/);
      /* No document content: the runtime document's own keys and the Juno configuration never reach the report. */
      for (const text of [human, JSON.stringify(machine)]) assert.ok(!/config_parameter_arn|ledger_table_arn|rest_endpoints|key_ref|BEGIN|PRIVATE/.test(text), "no document content or key material in the report");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  test("a failed read -> exit 3 NOT EVALUATED (record says so); a forgotten ALB -> exit 1", async () => {
    const dir = writeCapture(noEscrowFiles(), { [HOST_EVIDENCE_FILES.loadBalancers]: null });
    const rec = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cost2a-rec-")), "verify.json");
    const lines: string[] = [];
    try {
      assert.equal(await runDeployCommand(VERIFY(dir, ["--record", rec]), deps(lines)), EXIT_NOT_EVALUATED);
      assert.match(lines[lines.length - 1], /^NOT EVALUATED: .* NOT a pass$/);
      assert.ok(lines.some((l) => /^NOT EVALUATED  absent: load balancers and target groups/.test(l)));
      assert.equal((JSON.parse(fs.readFileSync(rec, "utf8")) as { verdict: string }).verdict, "NOT EVALUATED");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const alb = writeCapture(noEscrowFiles(), { [HOST_EVIDENCE_FILES.loadBalancers]: { LoadBalancers: [{ LoadBalancerName: `gs-${ENV}-alb` }] } });
    try {
      assert.equal(await runDeployCommand(VERIFY(alb), deps([])), EXIT_FAILED);
    } finally {
      fs.rmSync(alb, { recursive: true, force: true });
    }
  });

  test("the refusals that keep the topologies apart (usage, exit 2; nothing read)", async () => {
    const dir = writeCapture(noEscrowFiles());
    try {
      const refused = async (argv: string[], why: RegExp) => {
        const lines: string[] = [];
        assert.equal(await runDeployCommand(argv, deps(lines)), EXIT_USAGE, `${argv.join(" ")}: ${lines.join("\n")}`);
        assert.match(lines.join("\n"), why);
      };
      const ecs = ["verify", "--runtime-parameter", RUNTIME_ARN, "--environment", ENV, "--primary-pool", "p1", "--generation", "1", "--evidence", dir];
      await refused([...ecs, "--instance-id", ID], /host options need --topology/);
      await refused([...ecs, "--emergency-ssh"], /host options need --topology/);
      await refused(VERIFY(dir).filter((a) => a !== "--evidence" && a !== dir).concat(["--no-evidence"]), /--no-evidence is the ECS topology's/);
      await refused([...VERIFY(dir), "--flip-record", "x.json"], /--flip-record is the ECS topology's/);
      await refused([...VERIFY(dir), "--page-actions", "none"], /--page-actions is the ECS topology's/);
      await refused(VERIFY(dir).map((a) => (a === ID ? "none" : a)), /--instance-id none is coexistence only/);
      await refused([...VERIFY(dir), "--gs-origin", ALB_ORIGIN], /in the final state the \/gs\* origin IS the host's/);
      await refused(VERIFY(dir).map((a) => (a === "single-host" ? "coexist" : a)), /--gs-origin is required/);
      await refused(VERIFY(dir).map((a) => (a === DIGEST ? "sha256:short" : a)), /--expect-digest/);
      await refused(VERIFY(dir).map((a) => (a === "single-host" ? "ec2" : a)), /--topology is ecs, coexist or single-host/);
      await refused(["verify", "--part", "ledger", "--topology", "single-host", "--ledger-table-arn", LEDGER_ARN, "--environment", ENV, "--generation", "1"], /--part ledger is the ledger account's half/);
      await refused([...VERIFY(dir), "--instance-type", "m5.large"], /--instance-type is one of/);
      await refused([...VERIFY(dir), "--pools", "p1,p2"], /--topology single-host has one pool/);
      await refused([...VERIFY(dir), "--allow-eip", "198.51.100.30"], /--allow-eip/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ================================================================== */
/* §5 The sources                                                       */
/* ================================================================== */

describe("COST-2A §5: the capture scripts, the fixtures and the module agree with the verifier", () => {
  const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

  test("the capture scripts are describe / get / list only; the one Run Command is the FIXED gs-health; no value, secret or user data is read", () => {
    for (const rel of ["infra/aws/scripts/capture-host-evidence.sh", "infra/aws/scripts/capture-host-evidence.ps1"]) {
      const text = read(rel).split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
      const verbs = [...text.matchAll(/["\s(](ec2|iam|ecs|elbv2|cloudfront|logs|cloudwatch|budgets|ssm|sts)["\s,]+"?([a-z][a-z0-9-]+)"?/g)].map((m) => `${m[1]} ${m[2]}`);
      assert.ok(verbs.length > 30, `${rel}: the AWS calls were found (${verbs.length})`);
      const bad = verbs.filter((v) => !/^[a-z0-9]+ (describe|get|list)-[a-z0-9-]+$/.test(v) && v !== "ssm send-command");
      assert.deepEqual(bad, [], `${rel}: only describe / get / list (and the one send-command)`);
      assert.equal(verbs.filter((v) => v === "ssm send-command").length, 1, `${rel}: exactly one send-command`);
      assert.match(text, /commands"?\s*[:=]\s*(\[|@\()\s*["']\/opt\/gs\/bin\/gs-health["']/, `${rel}: the Run Command is the fixed /opt/gs/bin/gs-health`);
      for (const forbidden of [/get-parameters?\b/, /get-secret-value/, /userData/i, /describe-instance-attribute[^\n]*--attribute"?,?\s*"?user/i, /describe-notifications-for-budget|describe-subscribers/, /\b(put|delete|create|update|modify|terminate|stop|start|run|tag)-[a-z-]+\b/]) {
        assert.ok(!forbidden.test(text), `${rel}: ${forbidden}`);
      }
      assert.match(text, /disableApiTermination/, `${rel}: the one instance attribute asked is termination protection`);
      assert.match(text, /sensitive/, `${rel}: a sensitive Terraform output is refused`);
    }
  });

  test("every file the verifier reads is one the capture writes (and the manifest names the format)", () => {
    const sh = read("infra/aws/scripts/capture-host-evidence.sh");
    const ps = read("infra/aws/scripts/capture-host-evidence.ps1");
    for (const [key, file] of Object.entries(HOST_EVIDENCE_FILES)) {
      if (typeof file !== "string" || key === "runtimeSnapshot" || key === "manifest") continue;
      assert.ok(sh.includes(file), `capture-host-evidence.sh writes ${file}`);
      assert.ok(ps.includes(file), `capture-host-evidence.ps1 writes ${file}`);
    }
    assert.ok(sh.includes("target-health-${TG_NAME}.json") && ps.includes("target-health-$($parts[0]).json"));
    /* The names a capture clears before it runs are exactly the evidence names (never "every *.json"). */
    const shNames = /EVIDENCE_NAMES=\(([^)]*)\)/.exec(sh)?.[1].trim().split(/\s+/) ?? [];
    const psNames = [...(/\$evidenceNames = @\(([^)]*)\)/.exec(ps)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const wanted = Object.values(HOST_EVIDENCE_FILES).filter((v) => typeof v === "string").map(String).sort();
    assert.deepEqual([...shNames].sort(), wanted, "sh clears exactly the evidence names");
    assert.deepEqual([...psNames].sort(), wanted, "ps1 clears exactly the evidence names");
    for (const text of [sh, ps]) assert.ok(!/rm -f "\$OUT"\/\*\.json|-like "\*\.json"/.test(text), "never every *.json");
    for (const text of [sh, ps]) assert.ok(text.includes(HOST_EVIDENCE_FORMAT), "the manifest format");
    assert.ok(read("server/src/aws/operator/hostSnapshot.ts").includes(`export const HOST_RUNTIME_SNAPSHOT_FORMAT = "${HOST_RUNTIME_SNAPSHOT_FORMAT}";`), "the operator's snapshot and the verifier name one format");
  });

  test("the instance-type allow-list is the budget's; the five alarms are the module's", () => {
    const budget = JSON.parse(read("infra/aws/COST_BUDGET.json")) as { allowed_instance_types: string[]; max_alarms: number };
    assert.deepEqual([...HOST_INSTANCE_TYPES].sort(), [...budget.allowed_instance_types].sort());
    const tf = read("infra/aws/modules/single-host/observability.tf");
    const specs = hostAlarmSpecs(ENV, ID);
    assert.equal(specs.length, (tf.match(/resource "aws_cloudwatch_metric_alarm"/g) ?? []).length);
    for (const s of specs) {
      const suffix = s.name.slice(`gs-${ENV}-host-`.length);
      const block = tf.slice(tf.indexOf(`alarm_name          = "\${local.name}-${suffix}"`));
      assert.ok(block.length > 0 && tf.includes(`\${local.name}-${suffix}"`), `alarm ${suffix} in observability.tf`);
      const body = block.slice(0, block.indexOf("\n}\n"));
      assert.match(body, new RegExp(`metric_name\\s+= "${s.metric}"`), `${suffix}: metric`);
      assert.match(body, new RegExp(`threshold\\s+= ${s.threshold}\\b`), `${suffix}: threshold`);
      assert.match(body, new RegExp(`comparison_operator\\s+= "${s.comparison}"`), `${suffix}: comparison`);
      assert.match(body, new RegExp(`treat_missing_data\\s+= "${s.missing}"`), `${suffix}: missing data`);
    }
  });

  test("gs-health reports the fields the verifier reads (and never a value)", () => {
    const health = read("infra/aws/modules/single-host/files/bin/gs-health");
    for (const field of ["server", "caddy", "build", "digest", "running_digest", "hold", "healthz", "readyz", "origin_tls_readyz", "origin_hostname", "static_credentials"]) assert.match(health, new RegExp(`"${field}":"%s"`), field);
    const lib = read("infra/aws/modules/single-host/files/bin/gs-lib.sh");
    const fn = lib.slice(lib.indexOf("static_credentials() {"), lib.indexOf("running_digest() {"));
    assert.match(fn, /grep -Eo "\$GS_CREDENTIAL_NAMES_RE"/, "names are matched up to the '=' only");
    assert.ok(!/cut -d= -f2|\$\{line#\*=\}/.test(fn), "a value is never extracted");
  });
});

/* ================================================================== */
/* §6 The capture scripts themselves, over a stubbed AWS CLI            */
/* ================================================================== */

/** The stub CLI: answers `<service> <op>` from the scenario (JSON, or text for a --query), fails what the scenario says,
 *  and LOGS every call -- the ground truth of what a capture script asked AWS. */
const HOST_AWS_STUB = `
const fs = require("fs");
const argv = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(process.env.AWS_STUB_SCENARIO, "utf8"));
const flag = (name) => { let v = null; for (let i = 0; i < argv.length; i++) if (argv[i] === name) v = argv[i + 1]; return v; };
const words = [];
for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith("--")) { i++; continue; } words.push(argv[i]); }
const [service, op] = words;
const output = flag("--output");
const query = flag("--query");
fs.appendFileSync(process.env.AWS_STUB_LOG, JSON.stringify({ service, op, query, output }) + "\\n");
const key = service + " " + op;
if ((scenario.fail || []).includes(key)) { process.stderr.write("An error occurred (AccessDenied) when calling the " + op + " operation: not authorized\\n"); process.exit(254); }
if (output === "text" && query !== null) {
  const t = scenario.text[key + "|" + query] ?? scenario.text[key];
  if (t === undefined) { process.stderr.write("stub: no text for " + key + " " + query + "\\n"); process.exit(255); }
  process.stdout.write(t + "\\n"); process.exit(0);
}
const j = scenario.json[key];
if (j === undefined) { process.stderr.write("stub: no answer for " + key + "\\n"); process.exit(255); }
process.stdout.write(JSON.stringify(j, null, 2) + "\\n");
`;

function hostCaptureScenario(files: Files, now: number, fail: readonly string[] = []): Record<string, Json> {
  const json: Record<string, Json> = {
    "sts get-caller-identity": files[HOST_EVIDENCE_FILES.callerIdentity],
    "ec2 describe-instances": files[HOST_EVIDENCE_FILES.instances], // both listings (by tag, by the host profile) answer the one host
    "ec2 describe-instance-credit-specifications": files[HOST_EVIDENCE_FILES.creditSpecification],
    "ec2 describe-instance-attribute": files[HOST_EVIDENCE_FILES.terminationProtection],
    "ec2 describe-volumes": files[HOST_EVIDENCE_FILES.volumes],
    "ec2 describe-images": files[HOST_EVIDENCE_FILES.image],
    "ec2 describe-network-interfaces": files[HOST_EVIDENCE_FILES.networkInterfaces],
    "ec2 describe-addresses": files[HOST_EVIDENCE_FILES.addresses],
    "ec2 describe-security-groups": files[HOST_EVIDENCE_FILES.securityGroups],
    "ec2 describe-managed-prefix-lists": files[HOST_EVIDENCE_FILES.prefixList],
    "ec2 describe-nat-gateways": files[HOST_EVIDENCE_FILES.natGateways],
    "ec2 describe-vpc-endpoints": files[HOST_EVIDENCE_FILES.vpcEndpoints],
    "ssm describe-instance-information": files[HOST_EVIDENCE_FILES.ssmInstance],
    "iam get-instance-profile": files[HOST_EVIDENCE_FILES.instanceProfile],
    "iam get-role": files[HOST_EVIDENCE_FILES.role],
    "iam list-attached-role-policies": files[HOST_EVIDENCE_FILES.roleAttachedPolicies],
    "iam list-role-policies": files[HOST_EVIDENCE_FILES.roleInlinePolicies],
    "iam get-role-policy": files[HOST_EVIDENCE_FILES.rolePolicy],
    "cloudfront get-distribution-config": files[HOST_EVIDENCE_FILES.distributionConfig],
    "cloudfront get-origin-request-policy": files[HOST_EVIDENCE_FILES.originRequestPolicy],
    "logs describe-log-groups": files[HOST_EVIDENCE_FILES.logGroups],
    "cloudwatch describe-alarms": files[HOST_EVIDENCE_FILES.alarms],
    "budgets describe-budgets": files[HOST_EVIDENCE_FILES.budgets],
    "ecs describe-clusters": files[HOST_EVIDENCE_FILES.ecsClusters],
    "elbv2 describe-load-balancers": files[HOST_EVIDENCE_FILES.loadBalancers],
    "elbv2 describe-target-groups": files[HOST_EVIDENCE_FILES.targetGroups],
    "ssm get-command-invocation": { ...(files[HOST_EVIDENCE_FILES.hostHealth] as Record<string, Json>), ExecutionEndDateTime: iso(now) },
  };
  const text: Record<string, string> = {
    "sts get-caller-identity|Account": ACCOUNT,
    "sts get-caller-identity|Arn": `arn:aws:sts::${ACCOUNT}:assumed-role/gs-${ENV}-bootstrap/operator`,
    "ec2 describe-instances": `${AMI}\t${VPC}`,
    "cloudfront get-distribution-config": "orp-1",
    "ecs describe-clusters": "0",
    "elbv2 describe-target-groups": "",
    "ssm send-command": "11111111-2222-3333-4444-555555555555",
    "ssm get-command-invocation": "Success",
  };
  return { json, text, fail };
}

function runHostCapture(shell: "sh" | "ps1", scenario: Record<string, Json>, extra: { readonly sh: string[]; readonly ps1: string[] } = { sh: ["--host-status"], ps1: ["-HostStatus"] }): { readonly status: number | null; readonly stderr: string; readonly out: string; readonly calls: Array<Record<string, string | null>>; readonly cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cost2a-capture-"));
  const bin = path.join(root, "bin");
  const out = path.join(root, "evidence");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "aws-stub.js"), HOST_AWS_STUB);
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "aws.cmd"), `@"${process.execPath}" "%~dp0aws-stub.js" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
  else fs.writeFileSync(path.join(bin, "aws"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "aws-stub.js")}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "scenario.json"), JSON.stringify(scenario));
  /* Sleeps are the Run Command's poll; the stub answers at once. */
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, AWS_STUB_SCENARIO: path.join(root, "scenario.json"), AWS_STUB_LOG: path.join(root, "calls.log") };
  const scripts = path.join(INFRA, "scripts");
  const r =
    shell === "sh"
      ? spawnSync(BASH as string, [path.join(scripts, "capture-host-evidence.sh"), ENV, REGION, ID, "E123ABC456", out, ...extra.sh], { env, encoding: "utf8", timeout: 300_000 })
      : spawnSync(PWSH as string, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, "capture-host-evidence.ps1"), "-Environment", ENV, "-Region", REGION, "-InstanceId", ID, "-Distribution", "E123ABC456", "-Out", out, ...extra.ps1], { env, encoding: "utf8", timeout: 300_000 });
  const log = path.join(root, "calls.log");
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, string | null>) : [];
  return { status: r.status, stderr: `${r.stderr ?? ""}${r.error ? String(r.error) : ""}`, out, calls, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function probeShell(candidates: readonly string[], args: readonly string[]): string | null {
  for (const c of candidates) if (spawnSync(c, args, { encoding: "utf8", timeout: 60_000 }).status === 0) return c;
  return null;
}
/* bash on Windows may be WSL's (another filesystem): the .sh contract runs where bash is the host's (as L6-6P's). */
const BASH = process.platform === "win32" ? null : probeShell(["bash"], ["-c", "exit 0"]);
const PWSH = probeShell(process.platform === "win32" ? ["pwsh", "powershell"] : ["pwsh"], ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]);

describe("COST-2A §6: capture-host-evidence.{sh,ps1} over a stubbed AWS CLI (no AWS)", () => {
  for (const shell of ["sh", "ps1"] as const) {
    const skip = shell === "sh" ? (BASH === null ? "bash is not available here" : false) : PWSH === null ? "PowerShell is not available here" : false;

    test(`${shell}: a healthy host -> a capture the verifier PASSES; every call it made was a describe / get / list, plus exactly one Run Command of gs-health`, { skip }, () => {
      const now = Date.now();
      const files = finalFiles();
      files[HOST_EVIDENCE_FILES.runtimeSnapshot] = { ...(snapshot() as Record<string, Json>), captured_at: iso(now) };
      const run = runHostCapture(shell, hostCaptureScenario(files, now));
      try {
        assert.equal(run.status, 0, run.stderr);
        /* The operator's snapshot is its own step (gamesDoctor aws host-snapshot); here it is placed as that step would. */
        fs.writeFileSync(path.join(run.out, HOST_EVIDENCE_FILES.runtimeSnapshot), JSON.stringify(files[HOST_EVIDENCE_FILES.runtimeSnapshot]));
        const checks = checkHostEvidenceDirectory(run.out, expectFor("single-host", { now }), { escrow: true });
        assertPass(checks);
        const manifest = JSON.parse(fs.readFileSync(path.join(run.out, HOST_EVIDENCE_FILES.manifest), "utf8").replace(/^﻿/, "")) as { format: string; account: string; instance_id: string; host_status: string; calls: Array<{ ok: boolean }>; source_commit: string };
        assert.equal(manifest.format, HOST_EVIDENCE_FORMAT);
        assert.equal(manifest.account, ACCOUNT);
        assert.equal(manifest.instance_id, ID);
        assert.equal(manifest.host_status, "captured");
        assert.ok(manifest.calls.length >= 25 && manifest.calls.every((c) => c.ok), JSON.stringify(manifest.calls));
        const verbs = run.calls.map((c) => `${c.service} ${c.op}`);
        assert.deepEqual(verbs.filter((v) => !/^[a-z0-9]+ (describe|get|list)-[a-z0-9-]+$/.test(v)), ["ssm send-command"], "the only non-read is the one Run Command");
        for (const forbidden of ["ssm get-parameter", "ssm get-parameters", "secretsmanager get-secret-value"]) assert.ok(!verbs.includes(forbidden), forbidden);
        const attribute = run.calls.find((c) => c.op === "describe-instance-attribute");
        assert.ok(attribute !== undefined);
      } finally {
        run.cleanup();
      }
    });

    test(`${shell}: without --host-status nothing is run on the host, and the host checks are NOT EVALUATED`, { skip }, () => {
      const now = Date.now();
      const files = finalFiles();
      const run = runHostCapture(shell, hostCaptureScenario(files, now), { sh: [], ps1: [] });
      try {
        assert.equal(run.status, 0, run.stderr);
        assert.ok(!run.calls.some((c) => c.op === "send-command"), "no Run Command unless asked");
        fs.writeFileSync(path.join(run.out, HOST_EVIDENCE_FILES.runtimeSnapshot), JSON.stringify({ ...(snapshot() as Record<string, Json>), captured_at: iso(now) }));
        const checks = checkHostEvidenceDirectory(run.out, expectFor("single-host", { now }), { escrow: true });
        assert.equal(verdictOf(checks), "NOT EVALUATED", show(checks));
        assertNotEvaluated(checks, /host: release digest/, "no host status");
      } finally {
        run.cleanup();
      }
    });

    test(`${shell}: coexistence -- the drained ECS era is captured (services, tasks, EVERY target group's health) and verifies`, { skip }, () => {
      const now = Date.now();
      const files = coexistFiles();
      const scenario = hostCaptureScenario(files, now) as { json: Record<string, Json>; text: Record<string, string> };
      const arn = (p: string) => `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:targetgroup/gs-${ENV}-${p}/0123456789abcdef`;
      scenario.text["ecs describe-clusters"] = "1";
      scenario.text["ecs list-services"] = `arn:aws:ecs:${REGION}:${ACCOUNT}:service/gs-${ENV}/gs-${ENV}-p1\tarn:aws:ecs:${REGION}:${ACCOUNT}:service/gs-${ENV}/gs-${ENV}-p2`;
      scenario.text["elbv2 describe-target-groups"] = `gs-${ENV}-p1\t${arn("p1")}\ngs-${ENV}-p2\t${arn("p2")}`;
      scenario.json["ecs describe-services"] = files[HOST_EVIDENCE_FILES.ecsServices];
      scenario.json["ecs list-tasks"] = files[HOST_EVIDENCE_FILES.ecsRunningTasks];
      scenario.json["elbv2 describe-target-health"] = { TargetHealthDescriptions: [] };
      const run = runHostCapture(shell, scenario);
      try {
        assert.equal(run.status, 0, run.stderr);
        for (const p of ["p1", "p2"]) assert.ok(fs.existsSync(path.join(run.out, HOST_EVIDENCE_FILES.targetHealth(`gs-${ENV}-${p}`))), `target health of gs-${ENV}-${p}`);
        assert.equal(run.calls.filter((c) => c.op === "describe-target-health").length, 2, "one target-health read per target group");
        fs.writeFileSync(path.join(run.out, HOST_EVIDENCE_FILES.runtimeSnapshot), JSON.stringify({ ...(files[HOST_EVIDENCE_FILES.runtimeSnapshot] as Record<string, Json>), captured_at: iso(now) }));
        const checks = checkHostEvidenceDirectory(run.out, expectFor("coexist", { now }), { escrow: true });
        assertPass(checks);
        assert.equal(checks.find((c) => c.name === "ALB drained: no target registered")?.status, "pass");
        assert.equal(checks.find((c) => c.name === "ECS drained: no second serving writer")?.status, "pass");
      } finally {
        run.cleanup();
      }
    });

    test(`${shell}: a reused directory -- every earlier answer is removed first (a stale drained answer cannot stand in for this run's)`, { skip }, () => {
      const now = Date.now();
      const run1 = runHostCapture(shell, hostCaptureScenario(finalFiles(), now));
      try {
        assert.equal(run1.status, 0, run1.stderr);
        fs.writeFileSync(path.join(run1.out, HOST_EVIDENCE_FILES.ecsServices), JSON.stringify({ services: [] }));
        fs.writeFileSync(path.join(run1.out, HOST_EVIDENCE_FILES.terraformOutputs), "{}");
        const root = path.dirname(run1.out);
        const env = { ...process.env, PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH ?? ""}`, AWS_STUB_SCENARIO: path.join(root, "scenario.json"), AWS_STUB_LOG: path.join(root, "calls.log") };
        const scripts = path.join(INFRA, "scripts");
        const again =
          shell === "sh"
            ? spawnSync(BASH as string, [path.join(scripts, "capture-host-evidence.sh"), ENV, REGION, ID, "E123ABC456", run1.out], { env, encoding: "utf8", timeout: 300_000 })
            : spawnSync(PWSH as string, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, "capture-host-evidence.ps1"), "-Environment", ENV, "-Region", REGION, "-InstanceId", ID, "-Distribution", "E123ABC456", "-Out", run1.out], { env, encoding: "utf8", timeout: 300_000 });
        assert.equal(again.status, 0, again.stderr);
        for (const stale of [HOST_EVIDENCE_FILES.ecsServices, HOST_EVIDENCE_FILES.terraformOutputs, HOST_EVIDENCE_FILES.hostHealth]) assert.ok(!fs.existsSync(path.join(run1.out, stale)), `${stale} from the earlier run is gone`);
      } finally {
        run1.cleanup();
      }
    });

    test(`${shell}: a RELATIVE output directory with --terraform-dir (stub terraform) captures the outputs; files that are not evidence survive`, { skip }, () => {
      const now = Date.now();
      const files = finalFiles();
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "cost2a-rel-"));
      const bin = path.join(root, "bin");
      const stack = path.join(root, "stacks", "single-host");
      fs.mkdirSync(bin);
      fs.mkdirSync(stack, { recursive: true });
      fs.mkdirSync(path.join(root, "ev-F"));
      fs.writeFileSync(path.join(root, "ev-F", "verify.json"), "{\"kept\":true}");
      fs.writeFileSync(path.join(root, "ev-F", "package.json"), "{}");
      fs.writeFileSync(path.join(root, "ev-F", HOST_EVIDENCE_FILES.loadBalancers), JSON.stringify({ LoadBalancers: [{ LoadBalancerName: "stale" }] }));
      fs.writeFileSync(path.join(bin, "aws-stub.js"), HOST_AWS_STUB);
      const outputs = { instance_id: { value: ID, sensitive: false }, public_ip: { value: IP, sensitive: false }, origin_hostname: { value: ORIGIN, sensitive: false }, app_role_arn: { value: `arn:aws:iam::${ACCOUNT}:role/gs-${ENV}-host-app`, sensitive: false }, log_group: { value: `/gs/${ENV}/host`, sensitive: false }, runtime_parameter_arn: { value: RUNTIME_ARN, sensitive: false } };
      fs.writeFileSync(path.join(bin, "tf-stub.js"), `process.stderr.write("Warning: a provider note\\n"); process.stdout.write(${JSON.stringify(JSON.stringify(outputs))});`);
      if (process.platform === "win32") {
        fs.writeFileSync(path.join(bin, "aws.cmd"), `@"${process.execPath}" "%~dp0aws-stub.js" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
        fs.writeFileSync(path.join(bin, "terraform.cmd"), `@"${process.execPath}" "%~dp0tf-stub.js" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
      } else {
        fs.writeFileSync(path.join(bin, "aws"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "aws-stub.js")}" "$@"\n`, { mode: 0o755 });
        fs.writeFileSync(path.join(bin, "terraform"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "tf-stub.js")}" "$@"\n`, { mode: 0o755 });
      }
      fs.writeFileSync(path.join(root, "scenario.json"), JSON.stringify(hostCaptureScenario(files, now)));
      const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, AWS_STUB_SCENARIO: path.join(root, "scenario.json"), AWS_STUB_LOG: path.join(root, "calls.log") };
      const scripts = path.join(INFRA, "scripts");
      try {
        const r =
          shell === "sh"
            ? spawnSync(BASH as string, [path.join(scripts, "capture-host-evidence.sh"), ENV, REGION, ID, "E123ABC456", "ev-F", "--host-status", "--terraform-dir", path.join("stacks", "single-host")], { env, cwd: root, encoding: "utf8", timeout: 300_000 })
            : spawnSync(PWSH as string, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, "capture-host-evidence.ps1"), "-Environment", ENV, "-Region", REGION, "-InstanceId", ID, "-Distribution", "E123ABC456", "-Out", "ev-F", "-HostStatus", "-TerraformDir", path.join("stacks", "single-host")], { env, cwd: root, encoding: "utf8", timeout: 300_000 });
        assert.equal(r.status, 0, `${r.stderr}`);
        const out = path.join(root, "ev-F");
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, HOST_EVIDENCE_FILES.terraformOutputs), "utf8").replace(/^\uFEFF/, "")), outputs, "terraform's stdout only (its warning on stderr is not in the JSON)");
        assert.equal(fs.readFileSync(path.join(out, "verify.json"), "utf8"), "{\"kept\":true}", "a record kept beside the evidence survives");
        assert.ok(fs.existsSync(path.join(out, "package.json")), "a file that is not evidence is never deleted");
        assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(out, HOST_EVIDENCE_FILES.loadBalancers), "utf8").replace(/^\uFEFF/, ""))).includes("stale"), "the evidence itself is this run's");
        fs.writeFileSync(path.join(out, HOST_EVIDENCE_FILES.runtimeSnapshot), JSON.stringify({ ...(snapshot() as Record<string, Json>), captured_at: iso(now) }));
        const checks = checkHostEvidenceDirectory(out, expectFor("single-host", { now }), { escrow: true });
        assertPass(checks);
        assert.equal(checks.find((c) => c.name === "Terraform outputs = what runs")?.status, "pass");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test(`${shell}: a failed read is written as <name>.error.json (never an empty answer); the capture exits 1; the verifier is NOT EVALUATED`, { skip }, () => {
      const now = Date.now();
      const files = finalFiles();
      const run = runHostCapture(shell, hostCaptureScenario(files, now, ["elbv2 describe-load-balancers", "ec2 describe-nat-gateways"]));
      try {
        assert.equal(run.status, 1, run.stderr);
        assert.ok(!fs.existsSync(path.join(run.out, HOST_EVIDENCE_FILES.loadBalancers)), "no answer file for a failed read");
        const error = JSON.parse(fs.readFileSync(path.join(run.out, "load-balancers.error.json"), "utf8").replace(/^﻿/, "")) as { error: string; exit: number };
        assert.match(error.error, /AccessDenied/);
        assert.equal(error.exit, 254);
        fs.writeFileSync(path.join(run.out, HOST_EVIDENCE_FILES.runtimeSnapshot), JSON.stringify({ ...(snapshot() as Record<string, Json>), captured_at: iso(now) }));
        const checks = checkHostEvidenceDirectory(run.out, expectFor("single-host", { now }), { escrow: true });
        assert.equal(verdictOf(checks), "NOT EVALUATED", show(checks));
        assertNotEvaluated(checks, /absent: load balancers/, "the failed listing");
        assertNotEvaluated(checks, /absent: NAT gateways/, "the failed listing");
        assertNotEvaluated(checks, /every read succeeded/, "the manifest names the failed reads");
      } finally {
        run.cleanup();
      }
    });
  }
});
