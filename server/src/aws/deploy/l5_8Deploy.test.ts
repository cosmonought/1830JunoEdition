// server/src/aws/deploy/l5_8Deploy.test.ts
//
// ==================================================================
//  LIVE-5 L5-8: THE INFRASTRUCTURE CONTRACT, CHECKED WITHOUT AWS (`npm test`)
// ==================================================================
//
//   §1 the documents the Terraform app module renders (infra/aws/fixtures, asserted byte-for-byte by the module's own
//      `terraform test`) are accepted by THE TASK'S OWN CODE: `loadAwsStartup` over them (the runtime document, the Juno
//      v3 configuration in production mode, `checkEscrowConfigForAws`) -- the IaC and the parser cannot drift apart unseen;
//   §2 the IaC's static evidence: /gs* forwards ALL query strings (never an allow-list), every service is stop-first with
//      AZ rebalancing off, no table item is Terraform-managed (the bootstrap owns APPGEN and SYSTEM/ROUTING), no
//      SecureString and no Secrets Manager permission, every authoritative table protected;
//   §3 the verifier's control-plane checks: good evidence passes; each violation of L5-7 §14 fails by name;
//   §4 the verifier's table and KMS checks;
//   §5 the bootstrap's pure plan and the command's refusals (usage, a mis-pointed document).
// The bootstrap's writes are proven on DynamoDB Local (`persistence/conformance/awsBootstrap.dynamoLocal.test.ts`).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { TableDescription } from "@aws-sdk/client-dynamodb";

import { parseJunoBackendConfig } from "../../escrow/juno/junoConfig";
import { bigIntTo32, decompressPublicKey } from "../../escrow/juno/secp256k1";
import { loadAwsStartup } from "../runtime/awsMain";
import type { ParameterSource } from "../runtime/configSource";
import { checkEscrowConfigForAws, parseAwsRuntimeConfigText } from "../runtime/runtimeConfig";
import { bootstrapPlan, type BootstrapInspection } from "./bootstrap";
import { runDeployCommand, EXIT_USAGE, type DeployDeps } from "./commands";
import {
  CACHING_DISABLED_POLICY_ID,
  checkEdgeEvidence,
  checkListenerRulesEvidence,
  checkLoadBalancerEvidence,
  checkRuntimeDocument,
  checkSecurityGroupsEvidence,
  checkServicesEvidence,
  checkSigningKeys,
  checkTable,
  checkTargetGroupEvidence,
  checkEvidenceDirectory,
  checkTaskDefinitionEvidence,
  cloudFrontPatternMatches,
  EVIDENCE_FILES,
  type Check,
  type KeyDescription,
  type TableEvidence,
} from "./deployVerify";

const REPO = path.resolve(__dirname, "../../../../../.."); // dist/server/src/aws/deploy -> the repository
const INFRA = path.join(REPO, "infra/aws");
const fixture = (name: string) => fs.readFileSync(path.join(INFRA, "fixtures", name), "utf8");

const failures = (checks: readonly Check[]) => checks.filter((c) => c.status === "fail");
const assertAllPass = (checks: readonly Check[]) => assert.deepEqual(failures(checks), [], JSON.stringify(failures(checks), null, 2));
const assertFails = (checks: readonly Check[], name: RegExp, message: string) =>
  assert.ok(
    failures(checks).some((c) => name.test(c.name)),
    `${message}: expected a failure named ${name}; got ${JSON.stringify(failures(checks))}`,
  );

const RUNTIME_ARN = "arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p1";
const JUNO_ARN = "arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/juno-backend";

const fixtureParameters = (docs: Record<string, string>): ParameterSource => ({
  async read(arn) {
    const value = docs[arn];
    if (value === undefined) throw new Error(`no parameter ${arn}`);
    return { value, version: 3, arn };
  },
});

/* ------------------------------------------------------------------ */
/* §1 The rendered documents, through the task's own code               */
/* ------------------------------------------------------------------ */

describe("L5-8 §1: what Terraform renders is what the task parses", () => {
  test("the runtime documents (with and without escrow, both pools) parse strictly and name the contract's tables", () => {
    for (const [name, pool] of [
      ["runtime-staging-p1.json", "p1"],
      ["runtime-staging-p2.json", "p2"],
      ["runtime-staging-p1-noescrow.json", "p1"],
    ] as const) {
      const config = parseAwsRuntimeConfigText(fixture(name));
      assertAllPass(checkRuntimeDocument(config, { environment: "staging", generation: 1, pool }));
    }
  });

  test("the Juno v3 document parses in PRODUCTION and may run on AWS storage (the same ledger, KMS keys only, one region)", () => {
    const juno = parseJunoBackendConfig(JSON.parse(fixture("juno-backend-staging.json")), { serverMode: "production", dataDir: "/nonexistent" });
    assert.equal(juno.format, "18COSMOS/JUNO-BACKEND/v3");
    assert.equal(juno.kmsRegion, "us-east-1");
    assert.deepEqual(checkEscrowConfigForAws(juno, parseAwsRuntimeConfigText(fixture("runtime-staging-p1.json"))), []);
  });

  test("loadAwsStartup -- the task's startup step 1 -- accepts the pair exactly as served from SSM", async () => {
    const startup = await loadAwsStartup({
      argv: [],
      env: { GS_AWS_CONFIG_PARAMETER: RUNTIME_ARN },
      serverMode: "production",
      parameters: fixtureParameters({ [RUNTIME_ARN]: fixture("runtime-staging-p1.json"), [JUNO_ARN]: fixture("juno-backend-staging.json") }),
    });
    assert.equal(startup.config.pool, "p1");
    assert.equal(startup.escrowConfig?.journal.kind, "dynamodb");
  });
});

/* ------------------------------------------------------------------ */
/* §2 Static evidence from the IaC itself                               */
/* ------------------------------------------------------------------ */

function terraformFiles(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d)) {
      if (name === ".terraform") continue;
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".tf")) out.push({ file: path.relative(INFRA, full), text: fs.readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return out;
}

describe("L5-8 §2: the IaC's static evidence", () => {
  const files = terraformFiles(path.join(INFRA, "modules"));
  const all = files.map((f) => f.text).join("\n");

  test("the IaC was found", () => {
    assert.ok(files.some((f) => f.file === "modules/app/edge.tf") && files.some((f) => f.file === "modules/ledger/main.tf"), files.map((f) => f.file).join(", "));
  });

  test("/gs* forwards ALL query strings: every query_string_behavior is \"all\", and no query-string list exists anywhere", () => {
    const behaviors = [...all.matchAll(/query_string_behavior\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(behaviors.length >= 1, "an origin request policy exists");
    assert.deepEqual([...new Set(behaviors)], ["all"], "never whitelist / allExcept / none: a narrow list drops the next protocol field");
    assert.ok(!/query_strings\s*\{/.test(all), "no query_strings { items } allow-list block");
    assert.ok(!/forwarded_values\s*\{/.test(all), "no legacy forwarded_values (whose query_string_cache_keys narrow the query)");
    assert.ok(/cookie_behavior\s*=\s*"all"/.test(all) && /"Origin"/.test(all), "all cookies and Origin");
    assert.ok(/path_pattern\s*=\s*"\/gs\*"/.test(all) && /values\s*=\s*\["\/gs\*"\]/.test(all), "/gs* at the edge and on the ALB");
  });

  test("every service is stop-first (0 / 100) with AZ rebalancing off; no rolling overlap is configured anywhere", () => {
    assert.deepEqual([...all.matchAll(/deployment_minimum_healthy_percent\s*=\s*(\S+)/g)].map((m) => m[1]), ["0"]);
    assert.deepEqual([...all.matchAll(/deployment_maximum_percent\s*=\s*(\S+)/g)].map((m) => m[1]), ["100"]);
    assert.deepEqual([...all.matchAll(/availability_zone_rebalancing\s*=\s*(\S+)/g)].map((m) => m[1]), ['"DISABLED"']);
  });

  test("the control-plane records are not Terraform items; the documents are plain Strings; no Secrets Manager permission", () => {
    assert.ok(!/resource\s+"aws_dynamodb_table_item"/.test(all), "APPGEN and SYSTEM/ROUTING belong to the bootstrap, not to Terraform");
    assert.ok(!/SecureString/.test(all.replace(/#.*$/gm, "").replace(/\/\/.*$/gm, "")), "no SecureString parameter");
    assert.deepEqual([...all.matchAll(/type\s*=\s*"(String|StringList|SecureString)"/g)].map((m) => m[1]).filter((t) => t !== "String"), []);
    assert.ok(!/"secretsmanager:/.test(all), "no Secrets Manager action (no consumer yet)");
    assert.ok(!/resource\s+"aws_secretsmanager_secret"/.test(all), "no dummy secret");
  });

  test("every authoritative table and signing key is protected from destruction; tables have PITR and deletion protection", () => {
    for (const [file, resources] of [
      ["modules/app/tables.tf", ["game", "identity"]],
      ["modules/ledger/main.tf", ["ledger"]],
    ] as const) {
      const text = files.find((f) => f.file === file)?.text ?? "";
      for (const name of resources) {
        const block = text.slice(text.indexOf(`resource "aws_dynamodb_table" "${name}"`));
        const body = block.slice(0, block.indexOf("\n}\n")).replace(/#.*$/gm, ""); // code only, not its comments
        assert.ok(/deletion_protection_enabled\s*=\s*true/.test(body), `${name}: deletion protection`);
        assert.ok(/point_in_time_recovery\s*\{\s*enabled\s*=\s*true/.test(body), `${name}: PITR`);
        assert.ok(/prevent_destroy\s*=\s*true/.test(body), `${name}: prevent_destroy`);
        assert.ok(!/global_secondary_index|local_secondary_index|replica\s*\{|stream_enabled/.test(body), `${name}: no index, replica or stream`);
      }
    }
    const kms = files.find((f) => f.file === "modules/ledger/main.tf")?.text ?? "";
    assert.ok(/resource "aws_kms_key" "signing"[\s\S]*prevent_destroy\s*=\s*true/.test(kms), "the signing keys are prevent_destroy");
  });

  test("the task definition's environment is L5-7 §14's names only", () => {
    const locals = files.find((f) => f.file === "modules/app/locals.tf")?.text ?? "";
    const envBlock = locals.slice(locals.indexOf("container_environment"), locals.indexOf("healthz_command"));
    const names = [...envBlock.matchAll(/name = "([A-Z_]+)"/g)].map((m) => m[1]).sort();
    /* LIVE-6 L6-6 adds exactly one optional name: GS_EDGE_DIAGNOSTIC (the staging certification's edge mirror). */
    assert.deepEqual(names, ["BUILD_ID", "ESCROW_MONEY_TABLES", "GS_ALLOWED_ORIGINS", "GS_AWS_CONFIG_PARAMETER", "GS_EDGE_DIAGNOSTIC", "GS_MODE", "GS_STORAGE", "GS_TRUSTED_PROXY_HOPS", "PORT"]);
    const ecs = files.find((f) => f.file === "modules/app/ecs.tf")?.text ?? "";
    assert.ok(!/^\s*secrets\s*=/m.test(ecs) && !/environmentFiles\s*=/.test(ecs), "no secrets / environmentFiles injection");
    assert.ok(/stopTimeout\s*=\s*120/.test(ecs), "stopTimeout 120");
  });
});

/* ------------------------------------------------------------------ */
/* §3 Control-plane evidence                                            */
/* ------------------------------------------------------------------ */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const TASK_DEFINITION = {
  taskDefinition: {
    taskDefinitionArn: "arn:aws:ecs:us-east-1:111111111111:task-definition/gs-staging-p1:7",
    family: "gs-staging-p1",
    networkMode: "awsvpc",
    taskRoleArn: "arn:aws:iam::111111111111:role/gs-staging-app-task",
    containerDefinitions: [
      {
        name: "game-server",
        portMappings: [{ containerPort: 8917, hostPort: 8917, protocol: "tcp" }],
        environment: [
          { name: "GS_MODE", value: "production" },
          { name: "GS_STORAGE", value: "aws" },
          { name: "GS_AWS_CONFIG_PARAMETER", value: RUNTIME_ARN },
          { name: "BUILD_ID", value: "2026-09-30-test" },
          { name: "PORT", value: "8917" },
          { name: "GS_ALLOWED_ORIGINS", value: "https://play.example.com" },
          { name: "GS_TRUSTED_PROXY_HOPS", value: "2" },
        ],
        stopTimeout: 120,
        healthCheck: { command: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:'+process.env.PORT+'/gs/healthz',...)"] },
        logConfiguration: { logDriver: "awslogs", options: {} },
      },
    ],
  },
};
const TD_EXPECT = { environment: "staging", runtimeParameterArn: RUNTIME_ARN, port: 8917 };
const TG_ARN = "arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/gs-staging-primary/0123456789abcdef";

const SERVICES = {
  services: [
    {
      serviceName: "gs-staging-p1",
      desiredCount: 1,
      taskDefinition: "arn:aws:ecs:us-east-1:111111111111:task-definition/gs-staging-p1:7",
      deployments: [{ status: "PRIMARY", taskDefinition: "arn:aws:ecs:us-east-1:111111111111:task-definition/gs-staging-p1:7" }],
      deploymentConfiguration: { minimumHealthyPercent: 0, maximumPercent: 100, deploymentCircuitBreaker: { enable: true, rollback: true } },
      availabilityZoneRebalancing: "DISABLED",
      enableExecuteCommand: false,
      networkConfiguration: { awsvpcConfiguration: { assignPublicIp: "DISABLED" } },
      loadBalancers: [{ targetGroupArn: TG_ARN, containerName: "game-server", containerPort: 8917 }],
    },
    {
      serviceName: "gs-staging-p2",
      desiredCount: 1,
      taskDefinition: "arn:aws:ecs:us-east-1:111111111111:task-definition/gs-staging-p2:3",
      deployments: [{ status: "PRIMARY", taskDefinition: "arn:aws:ecs:us-east-1:111111111111:task-definition/gs-staging-p2:3" }],
      deploymentConfiguration: { minimumHealthyPercent: 0, maximumPercent: 100, deploymentCircuitBreaker: { enable: true, rollback: true } },
      availabilityZoneRebalancing: "DISABLED",
      enableExecuteCommand: false,
      networkConfiguration: { awsvpcConfiguration: { assignPublicIp: "DISABLED" } },
      loadBalancers: [],
    },
  ],
};
const SVC_EXPECT = { environment: "staging", pools: ["p1", "p2"], primaryPool: "p1" };

const TARGET_GROUPS = { TargetGroups: [{ TargetGroupArn: TG_ARN, TargetGroupName: "gs-staging-primary", HealthCheckPath: "/gs/readyz", Matcher: { HttpCode: "200" }, TargetType: "ip" }] };
const LISTENER_RULES = {
  Rules: [
    { Priority: "10", Conditions: [{ Field: "path-pattern", Values: ["/gs*"], PathPatternConfig: { Values: ["/gs*"] } }], Actions: [{ Type: "forward", TargetGroupArn: TG_ARN }] },
    { Priority: "default", IsDefault: true, Conditions: [], Actions: [{ Type: "fixed-response" }] },
  ],
};
const LB_ATTRIBUTES = { Attributes: [{ Key: "idle_timeout.timeout_seconds", Value: "300" }] };

const ORP_ID = "a1b2c3d4-0000-4000-8000-000000000001";
const DISTRIBUTION = {
  DistributionConfig: {
    Origins: {
      Items: [
        { Id: "site", DomainName: "site-origin.example.com", CustomOriginConfig: { OriginProtocolPolicy: "https-only" } },
        { Id: "gs-alb", DomainName: "gs-origin.example.com", CustomOriginConfig: { OriginProtocolPolicy: "https-only" } },
      ],
    },
    DefaultCacheBehavior: { TargetOriginId: "site" },
    CacheBehaviors: {
      Quantity: 1,
      Items: [
        {
          PathPattern: "/gs*",
          TargetOriginId: "gs-alb",
          ViewerProtocolPolicy: "https-only",
          AllowedMethods: { Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"] },
          CachePolicyId: CACHING_DISABLED_POLICY_ID,
          OriginRequestPolicyId: ORP_ID,
        },
      ],
    },
  },
};
const ORIGIN_REQUEST_POLICY = {
  OriginRequestPolicy: {
    Id: ORP_ID,
    OriginRequestPolicyConfig: {
      QueryStringsConfig: { QueryStringBehavior: "all", QueryStrings: { Quantity: 0 } },
      CookiesConfig: { CookieBehavior: "all" },
      HeadersConfig: { HeaderBehavior: "whitelist", Headers: { Items: ["Origin", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Protocol", "Sec-WebSocket-Accept", "Sec-WebSocket-Extensions"] } },
    },
  },
};

const SECURITY_GROUPS = {
  SecurityGroups: [
    { GroupName: "gs-staging-alb", GroupId: "sg-alb", IpPermissions: [{ IpProtocol: "tcp", FromPort: 443, ToPort: 443, PrefixListIds: [{ PrefixListId: "pl-cf" }], IpRanges: [], Ipv6Ranges: [], UserIdGroupPairs: [] }] },
    { GroupName: "gs-staging-task", GroupId: "sg-task", IpPermissions: [{ IpProtocol: "tcp", FromPort: 8917, ToPort: 8917, IpRanges: [], Ipv6Ranges: [], PrefixListIds: [], UserIdGroupPairs: [{ GroupId: "sg-alb" }] }] },
  ],
};

describe("L5-8 §3: the verifier's control-plane checks", () => {
  test("good evidence passes every check", () => {
    assertAllPass([
      ...checkTaskDefinitionEvidence("p1", TASK_DEFINITION, TD_EXPECT),
      ...checkServicesEvidence(SERVICES, SVC_EXPECT),
      ...checkTargetGroupEvidence(TARGET_GROUPS),
      ...checkLoadBalancerEvidence(LB_ATTRIBUTES),
      ...checkEdgeEvidence(DISTRIBUTION, ORIGIN_REQUEST_POLICY),
      ...checkSecurityGroupsEvidence(SECURITY_GROUPS, { environment: "staging", port: 8917 }),
      ...checkListenerRulesEvidence(LISTENER_RULES, TG_ARN),
    ]);
  });

  test("a task definition with a data directory, an escrow file, static credentials, injected secrets or a wrong reference fails", () => {
    const env = (mutate: (e: Array<{ name: string; value: string }>) => void) => {
      const td = clone(TASK_DEFINITION);
      mutate(td.taskDefinition.containerDefinitions[0].environment);
      return checkTaskDefinitionEvidence("p1", td, TD_EXPECT);
    };
    for (const name of ["DATA_DIR", "ESCROW_JUNO_CONFIG", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
      assertFails(
        env((e) => e.push({ name, value: "x" })),
        /no forbidden variable/,
        name,
      );
    }
    assertFails(
      env((e) => e.push({ name: "GS_EXTRA", value: "x" })),
      /environment names/,
      "an unexpected variable",
    );
    assertFails(
      env((e) => e.splice(0, 1)),
      /environment names/,
      "GS_MODE missing",
    );
    assertFails(
      env((e) => (e[2].value = "arn:aws:ssm:us-east-1:111111111111:parameter/gs/prod/runtime/p1")),
      /environment values/,
      "another document",
    );
    assertFails(
      env((e) => e.push({ name: "ESCROW_MONEY_TABLES", value: "all" })),
      /environment values/,
      "an unknown money switch",
    );
    const secrets = clone(TASK_DEFINITION) as { taskDefinition: { containerDefinitions: Array<Record<string, unknown>> } };
    secrets.taskDefinition.containerDefinitions[0].secrets = [{ name: "RPC_KEY", valueFrom: "arn:aws:secretsmanager:..." }];
    assertFails(checkTaskDefinitionEvidence("p1", secrets, TD_EXPECT), /no secret injection/, "ECS secrets injection");
    const files = clone(TASK_DEFINITION) as { taskDefinition: { containerDefinitions: Array<Record<string, unknown>> } };
    files.taskDefinition.containerDefinitions[0].environmentFiles = [{ value: "arn:aws:s3:::x/env", type: "s3" }];
    assertFails(checkTaskDefinitionEvidence("p1", files, TD_EXPECT), /no secret injection/, "environmentFiles");
    const stop = clone(TASK_DEFINITION);
    stop.taskDefinition.containerDefinitions[0].stopTimeout = 30;
    assertFails(checkTaskDefinitionEvidence("p1", stop, TD_EXPECT), /stopTimeout/, "a short stopTimeout");
    const health = clone(TASK_DEFINITION);
    health.taskDefinition.containerDefinitions[0].healthCheck.command = ["CMD", "curl", "http://127.0.0.1:8917/gs/readyz"];
    assertFails(checkTaskDefinitionEvidence("p1", health, TD_EXPECT), /container health/, "a readiness container check (would kill a standby)");
  });

  test("a rolling (100/200) or overlapping service, a public IP, ECS Exec, or a standby behind the ALB fails", () => {
    const svc = (mutate: (s: (typeof SERVICES)["services"]) => void) => {
      const doc = clone(SERVICES);
      mutate(doc.services);
      return checkServicesEvidence(doc, SVC_EXPECT);
    };
    assertFails(
      svc((s) => (s[0].deploymentConfiguration = { ...s[0].deploymentConfiguration, minimumHealthyPercent: 100, maximumPercent: 200 })),
      /stop-first/,
      "the generic rolling default",
    );
    assertFails(
      svc((s) => (s[0].deploymentConfiguration.maximumPercent = 200)),
      /stop-first/,
      "an overlap",
    );
    assertFails(
      svc((s) => (s[0].availabilityZoneRebalancing = "ENABLED")),
      /AZ rebalancing off/,
      "AZ rebalancing",
    );
    assertFails(
      svc((s) => (s[0].desiredCount = 2)),
      /one task/,
      "two tasks of one pool",
    );
    assertFails(
      svc((s) => (s[0].enableExecuteCommand = true)),
      /no ECS Exec/,
      "ECS Exec",
    );
    assertFails(
      svc((s) => (s[0].networkConfiguration.awsvpcConfiguration.assignPublicIp = "ENABLED")),
      /no public IP/,
      "a public IP",
    );
    assertFails(
      svc((s) => (s[1].loadBalancers as unknown[]).push({ targetGroupArn: "arn:tg2", containerName: "game-server", containerPort: 8917 })),
      /p2: load balancer/,
      "a standby behind the ALB",
    );
    assertFails(
      svc((s) => s.pop()),
      /p2: exists/,
      "a missing service",
    );
    assertFails(
      svc((s) => (s[0].deploymentConfiguration.deploymentCircuitBreaker = { enable: false, rollback: false })),
      /circuit breaker/,
      "no circuit breaker",
    );
    assertFails(
      svc((s) => s[0].deployments.push({ status: "ACTIVE", taskDefinition: "arn:aws:ecs:us-east-1:111111111111:task-definition/gs-staging-p1:6" })),
      /p1: settled/,
      "a deployment in progress",
    );
  });

  test("target health on liveness, a non-200 matcher or a short idle timeout fails", () => {
    const tg = clone(TARGET_GROUPS);
    tg.TargetGroups[0].HealthCheckPath = "/gs/healthz";
    assertFails(checkTargetGroupEvidence(tg), /health path/, "liveness as target health");
    const matcher = clone(TARGET_GROUPS);
    matcher.TargetGroups[0].Matcher.HttpCode = "200-499";
    assertFails(checkTargetGroupEvidence(matcher), /healthy = 200/, "a 503 counted healthy");
    assertFails(checkLoadBalancerEvidence({ Attributes: [{ Key: "idle_timeout.timeout_seconds", Value: "60" }] }), /idle timeout/, "60 s");
  });

  test("the edge: an allow-list of query strings -- even cp, cr, cb -- fails; so do no query, no cookies, no Origin, caching, a shadowing behaviour", () => {
    const orp = (mutate: (c: Record<string, any>) => void) => {
      const doc = clone(ORIGIN_REQUEST_POLICY) as { OriginRequestPolicy: { OriginRequestPolicyConfig: Record<string, any> } };
      mutate(doc.OriginRequestPolicy.OriginRequestPolicyConfig);
      return checkEdgeEvidence(DISTRIBUTION, doc);
    };
    assertFails(
      orp((c) => (c.QueryStringsConfig = { QueryStringBehavior: "whitelist", QueryStrings: { Quantity: 3, Items: ["cp", "cr", "cb"] } })),
      /ALL query strings/,
      "an allow-list naming today's fields drops tomorrow's",
    );
    assertFails(
      orp((c) => (c.QueryStringsConfig = { QueryStringBehavior: "none" })),
      /ALL query strings/,
      "no query",
    );
    assertFails(
      orp((c) => (c.QueryStringsConfig = { QueryStringBehavior: "allExcept", QueryStrings: { Quantity: 1, Items: ["cb"] } })),
      /ALL query strings/,
      "allExcept",
    );
    assertFails(
      orp((c) => (c.CookiesConfig = { CookieBehavior: "none" })),
      /cookies/,
      "no cookies",
    );
    assertFails(
      orp((c) => (c.HeadersConfig = { HeaderBehavior: "whitelist", Headers: { Items: ["Sec-WebSocket-Key", "Sec-WebSocket-Version"] } })),
      /Origin \+ WebSocket headers/,
      "no Origin",
    );
    assertFails(
      orp((c) => (c.HeadersConfig = { HeaderBehavior: "whitelist", Headers: { Items: ["Origin"] } })),
      /Origin \+ WebSocket headers/,
      "no WebSocket headers",
    );
    assertAllPass(checkEdgeEvidence(DISTRIBUTION, (() => {
      const doc = clone(ORIGIN_REQUEST_POLICY) as { OriginRequestPolicy: { OriginRequestPolicyConfig: Record<string, any> } };
      doc.OriginRequestPolicy.OriginRequestPolicyConfig.HeadersConfig = { HeaderBehavior: "allViewer" };
      return doc;
    })()));

    const dist = (mutate: (d: Record<string, any>) => void) => {
      const doc = clone(DISTRIBUTION) as { DistributionConfig: Record<string, any> };
      mutate(doc.DistributionConfig);
      return checkEdgeEvidence(doc, ORIGIN_REQUEST_POLICY);
    };
    assertFails(
      dist((d) => (d.CacheBehaviors.Items[0].CachePolicyId = "658327ea-f89d-4fab-a63d-7e88639e58f6")),
      /uncached/,
      "a caching policy",
    );
    assertFails(
      dist((d) => d.CacheBehaviors.Items.unshift({ PathPattern: "/g*", TargetOriginId: "site" })),
      /matches first/,
      "an earlier behaviour taking /gs paths",
    );
    assertFails(
      dist((d) => (d.CacheBehaviors = { Quantity: 0, Items: [] })),
      /\/gs\* behaviour/,
      "no /gs* behaviour",
    );
    assertFails(
      dist((d) => (d.CacheBehaviors.Items[0].OriginRequestPolicyId = "another")),
      /origin request policy/,
      "the evidence is another policy",
    );
    assertFails(
      dist((d) => (d.Origins.Items[1].CustomOriginConfig.OriginProtocolPolicy = "http-only")),
      /origin over https/,
      "plaintext to the ALB",
    );
  });

  test("an evidence directory: every file read (a PowerShell BOM tolerated); a missing file is a failure, never a skip", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-l58-evidence-"));
    try {
      const write = (file: string, value: unknown) => fs.writeFileSync(path.join(dir, file), `\uFEFF${JSON.stringify(value)}`, "utf8");
      write(EVIDENCE_FILES.taskDefinition("p1"), TASK_DEFINITION);
      write(EVIDENCE_FILES.services, { services: [SERVICES.services[0]] });
      write(EVIDENCE_FILES.targetGroups, TARGET_GROUPS);
      write(EVIDENCE_FILES.loadBalancerAttributes, LB_ATTRIBUTES);
      write(EVIDENCE_FILES.distributionConfig, DISTRIBUTION);
      write(EVIDENCE_FILES.originRequestPolicy, ORIGIN_REQUEST_POLICY);
      write(EVIDENCE_FILES.securityGroups, SECURITY_GROUPS);
      write(EVIDENCE_FILES.listenerRules, LISTENER_RULES);
      const expect = { environment: "staging", pools: ["p1"], primaryPool: "p1", port: 8917, runtimeParameterArns: new Map([["p1", RUNTIME_ARN]]) };
      assertAllPass(checkEvidenceDirectory(dir, expect));
      const stale = clone(TASK_DEFINITION);
      stale.taskDefinition.taskDefinitionArn = "arn:aws:ecs:us-east-1:111111111111:task-definition/gs-staging-p1:8";
      write(EVIDENCE_FILES.taskDefinition("p1"), stale);
      assertFails(checkEvidenceDirectory(dir, expect), /the running revision/, "the family's latest revision after a rollback is not the running one");
      write(EVIDENCE_FILES.taskDefinition("p1"), TASK_DEFINITION);
      fs.rmSync(path.join(dir, EVIDENCE_FILES.originRequestPolicy));
      assertFails(checkEvidenceDirectory(dir, expect), /evidence origin-request-policy.json/, "a missing file");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CloudFront path patterns: /gs* takes /gs and everything under it", () => {
    for (const p of ["/gs", "/gs/", "/gs/api/session", "/gs/ws"]) assert.ok(cloudFrontPatternMatches("/gs*", p), p);
    assert.ok(!cloudFrontPatternMatches("/gs/*", "/gs"));
    assert.ok(cloudFrontPatternMatches("/g*", "/gs/ws"));
    assert.ok(!cloudFrontPatternMatches("/api/*", "/gs/ws"));
  });

  test("any ingress to the task other than the container port from the ALB's security group fails", () => {
    const sg = (mutate: (perms: Array<Record<string, any>>) => void) => {
      const doc = clone(SECURITY_GROUPS) as { SecurityGroups: Array<{ IpPermissions: Array<Record<string, any>> }> };
      mutate(doc.SecurityGroups[1].IpPermissions);
      return checkSecurityGroupsEvidence(doc, { environment: "staging", port: 8917 });
    };
    assertFails(
      sg((p) => (p[0].IpRanges = [{ CidrIp: "0.0.0.0/0" }])),
      /ALB only/,
      "public direct ingress",
    );
    assertFails(
      sg((p) => p.push({ IpProtocol: "tcp", FromPort: 22, ToPort: 22, UserIdGroupPairs: [{ GroupId: "sg-alb" }] })),
      /ALB only/,
      "another port",
    );
    assertFails(
      sg((p) => (p[0].UserIdGroupPairs = [{ GroupId: "sg-other" }])),
      /ALB only/,
      "another source group",
    );
    const openAlb = clone(SECURITY_GROUPS) as { SecurityGroups: Array<{ IpPermissions: Array<Record<string, any>> }> };
    openAlb.SecurityGroups[0].IpPermissions[0].IpRanges = [{ CidrIp: "0.0.0.0/0" }];
    assertFails(checkSecurityGroupsEvidence(openAlb, { environment: "staging", port: 8917 }), /ALB security group/, "an ALB open to the internet (bypassing the edge)");
  });

  test("the ALB's /gs* rule must forward to the primary service's target group", () => {
    const other = clone(LISTENER_RULES) as { Rules: Array<{ Actions: Array<Record<string, unknown>> }> };
    other.Rules[0].Actions[0].TargetGroupArn = "arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/other/1";
    assertFails(checkListenerRulesEvidence(other, TG_ARN), /\/gs\* rule/, "another target group");
    assertFails(checkListenerRulesEvidence({ Rules: [LISTENER_RULES.Rules[1]] }, TG_ARN), /\/gs\* rule/, "no /gs* rule");
  });
});

/* ------------------------------------------------------------------ */
/* §4 Tables and KMS                                                    */
/* ------------------------------------------------------------------ */

const table = (name: string, extra: Partial<TableDescription> = {}): TableDescription => ({
  TableName: name,
  TableStatus: "ACTIVE",
  KeySchema: [
    { AttributeName: "pk", KeyType: "HASH" },
    { AttributeName: "sk", KeyType: "RANGE" },
  ],
  AttributeDefinitions: [
    { AttributeName: "pk", AttributeType: "S" },
    { AttributeName: "sk", AttributeType: "S" },
  ],
  BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
  DeletionProtectionEnabled: true,
  ...extra,
});
const evidence = (t: TableDescription, ttl: { status: string | null; attribute: string | null } = { status: "DISABLED", attribute: null }, pitr = "ENABLED"): TableEvidence => ({ table: t, pitr: { status: pitr }, ttl });

describe("L5-8 §4: the verifier's table and KMS checks", () => {
  test("the contract's tables pass; TTL is `ttl` on the identity table only", () => {
    assertAllPass(checkTable("game table", evidence(table("gs-staging-game-g1")), { name: "gs-staging-game-g1", ttlAttribute: null }));
    assertAllPass(checkTable("identity table", evidence(table("gs-staging-identity"), { status: "ENABLED", attribute: "ttl" }), { name: "gs-staging-identity", ttlAttribute: "ttl" }));
    assertFails(checkTable("identity table", evidence(table("gs-staging-identity")), { name: "gs-staging-identity", ttlAttribute: "ttl" }), /TTL/, "identity without TTL");
    assertFails(checkTable("game table", evidence(table("gs-staging-game-g1"), { status: "ENABLED", attribute: "ttl" }), { name: "gs-staging-game-g1", ttlAttribute: null }), /TTL/, "a TTL on the game table");
    assertFails(checkTable("ledger table", evidence(table("gs-staging-ledger"), { status: "ENABLED", attribute: "expires" }), { name: "gs-staging-ledger", ttlAttribute: null }), /TTL/, "a TTL on the ledger");
  });

  test("an index, a replica, provisioned capacity, a missing protection or PITR, another key schema, another name fails", () => {
    const expect = { name: "gs-staging-game-g1", ttlAttribute: null };
    const cases: Array<[TableEvidence, RegExp]> = [
      [evidence(table("gs-staging-game-g1", { GlobalSecondaryIndexes: [{ IndexName: "g" }] })), /no secondary index/],
      [evidence(table("gs-staging-game-g1", { LocalSecondaryIndexes: [{ IndexName: "l" }] })), /no secondary index/],
      [evidence(table("gs-staging-game-g1", { Replicas: [{ RegionName: "us-west-2" }] })), /Global Table/],
      [evidence(table("gs-staging-game-g1", { BillingModeSummary: { BillingMode: "PROVISIONED" } })), /on-demand/],
      [evidence(table("gs-staging-game-g1", { DeletionProtectionEnabled: false })), /deletion protection/],
      [evidence(table("gs-staging-game-g1"), undefined, "DISABLED"), /PITR/],
      [evidence(table("gs-staging-game-g1", { KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }] })), /keys/],
      [evidence(table("gs-staging-game-g1", { AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "N" }] })), /keys/],
      [evidence(table("gs-staging-game-g2")), /name/],
      [{ table: null, pitr: { error: "x" }, ttl: { error: "x" }, error: "ResourceNotFoundException" }, /exists/],
    ];
    for (const [ev, name] of cases) assertFails(checkTable("game table", ev, expect), name, String(name));
  });

  test("the runtime document's names follow the contract", () => {
    const config = parseAwsRuntimeConfigText(fixture("runtime-staging-p1.json"));
    assertFails(checkRuntimeDocument(config, { environment: "prod", generation: 1, pool: "p1" }), /environment/, "another environment");
    assertFails(checkRuntimeDocument(config, { environment: "staging", generation: 2, pool: "p1" }), /generation/, "another generation");
  });

  /* Test keys (their public halves are the fixture's): 11 relayer, 12 settlement, 13 admission. */
  const spkiOf = (compressedHex: string): Uint8Array => {
    const { x, y } = decompressPublicKey(Buffer.from(compressedHex, "hex"));
    return Buffer.concat([Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex"), Buffer.from([4]), bigIntTo32(x), bigIntTo32(y)]);
  };
  const juno = () => parseJunoBackendConfig(JSON.parse(fixture("juno-backend-staging.json")), { serverMode: "production", dataDir: "/nonexistent" });
  const PUBLIC: Record<string, string> = {
    "arn:aws:kms:us-east-1:222222222222:key/11111111-1111-4111-8111-111111111111": "03774ae7f858a9411e5ef4246b70c65aac5649980be5c17891bbec17895da008cb",
    "arn:aws:kms:us-east-1:222222222222:key/22222222-2222-4222-8222-222222222222": "03d01115d548e7561b15c38f004d734633687cf4419620095bc5b0f47070afe85a",
    "arn:aws:kms:us-east-1:222222222222:key/33333333-3333-4333-8333-333333333333": "03f28773c2d975288bc7d1d205c3748651b075fbc6610e58cddeeddf8f19405aa8",
  };
  const reader = (overrides: { describe?: (arn: string) => Partial<KeyDescription>; publicKey?: (arn: string) => string; grants?: (arn: string) => number } = {}) => ({
    async describe(arn: string): Promise<KeyDescription> {
      return { Arn: arn, KeyState: "Enabled", KeySpec: "ECC_SECG_P256K1", KeyUsage: "SIGN_VERIFY", KeyManager: "CUSTOMER", MultiRegion: false, SigningAlgorithms: ["ECDSA_SHA_256"], ...(overrides.describe?.(arn) ?? {}) };
    },
    async grantCount(arn: string): Promise<number> {
      return overrides.grants?.(arn) ?? 0;
    },
    digest: {
      async getPublicKey(arn: string) {
        return spkiOf(overrides.publicKey?.(arn) ?? PUBLIC[arn]);
      },
      async signDigest(): Promise<Uint8Array> {
        throw new Error("the verifier never signs");
      },
    },
  });

  test("the keys: enabled, customer-managed, single-region secp256k1 signers whose public keys are the configuration's", async () => {
    assertAllPass(await checkSigningKeys(juno(), reader()));
    assertFails(await checkSigningKeys(juno(), reader({ describe: (arn) => (arn.includes("2222") ? { KeyState: "Disabled" } : {}) })), /settlement key: metadata/, "a disabled key");
    assertFails(await checkSigningKeys(juno(), reader({ describe: () => ({ MultiRegion: true }) })), /metadata/, "a multi-region key");
    assertFails(await checkSigningKeys(juno(), reader({ grants: (arn) => (arn.includes("1111") ? 1 : 0) })), /relayer key: no grants/, "a grant handing out Sign");
    assertFails(await checkSigningKeys(juno(), reader({ describe: (arn) => ({ Arn: arn.replace(/key\/.*/, "alias/x") }) })), /metadata/, "an answer for another name");
    const swapped = (arn: string) => PUBLIC[arn.includes("1111") ? Object.keys(PUBLIC)[1] : arn.includes("2222") ? Object.keys(PUBLIC)[0] : arn];
    assertFails(await checkSigningKeys(juno(), reader({ publicKey: swapped })), /public keys = the configuration's/, "relayer and settlement keys swapped");
  });
});

/* ------------------------------------------------------------------ */
/* §5 The bootstrap's plan and the command's refusals                   */
/* ------------------------------------------------------------------ */

describe("L5-8 §5: the bootstrap's plan and the command's refusals", () => {
  const I = (appgen: BootstrapInspection["appgen"], routing: BootstrapInspection["routing"]): BootstrapInspection => ({ appgen, routing });

  test("absent -> created; matches -> nothing; conflict or unreadable -> the whole bootstrap refused", () => {
    assert.deepEqual(bootstrapPlan(I({ kind: "absent" }, { kind: "absent" })), { refused: [], writes: ["APPGEN (create-if-absent)", "SYSTEM/ROUTING (create-if-absent, routing_version 1)"] });
    assert.deepEqual(bootstrapPlan(I({ kind: "matches", detail: "g1" }, { kind: "matches", detail: "p1" })), { refused: [], writes: [] });
    assert.deepEqual(bootstrapPlan(I({ kind: "absent" }, { kind: "conflict", detail: "names p2" })).refused, ["SYSTEM/ROUTING: names p2"]);
    assert.deepEqual(bootstrapPlan(I({ kind: "unreadable", detail: "schema 2" }, { kind: "absent" })).refused, ["APPGEN: schema 2"]);
  });

  const deps = (docs: Record<string, string>, lines: string[]): DeployDeps => ({
    parameters: fixtureParameters(docs),
    dynamo: () => {
      throw new Error("no DynamoDB call is expected in this case");
    },
    kms: () => {
      throw new Error("no KMS call is expected in this case");
    },
    now: () => 0,
    out: (line) => lines.push(line),
  });

  test("usage: every flag required; exclusive modes; the verifier must name its evidence or skip it explicitly", async () => {
    const lines: string[] = [];
    const d = deps({}, lines);
    assert.equal(await runDeployCommand([], d), EXIT_USAGE);
    assert.equal(await runDeployCommand(["bootstrap", "--environment", "staging"], d), EXIT_USAGE);
    assert.equal(await runDeployCommand(["bootstrap", "--runtime-parameter", RUNTIME_ARN, "--environment", "staging", "--primary-pool", "p1", "--generation", "1", "--by", "x", "--apply", "--check"], d), EXIT_USAGE);
    assert.equal(await runDeployCommand(["bootstrap", "--runtime-parameter", RUNTIME_ARN, "--environment", "Staging!", "--primary-pool", "p1", "--generation", "1", "--by", "x"], d), EXIT_USAGE);
    assert.equal(await runDeployCommand(["verify", "--runtime-parameter", RUNTIME_ARN, "--environment", "staging", "--primary-pool", "p1", "--generation", "1"], d), EXIT_USAGE);
    assert.ok(lines.some((l) => /--evidence <dir>.*--no-evidence/.test(l)), lines.join("\n"));
    assert.equal(await runDeployCommand(["signer-keys", "--relayer", "arn:aws:kms:us-east-1:222222222222:alias/x", "--settlement", "a", "--admission", "b"], d), EXIT_USAGE);
  });

  test("a runtime document the task would refuse (a SecureString-shaped secret field, an unknown field) refuses the bootstrap before any table is touched", async () => {
    const lines: string[] = [];
    const bad = JSON.stringify({ ...JSON.parse(fixture("runtime-staging-p1-noescrow.json")), rpc_api_key: "not-allowed" });
    const code = await runDeployCommand(["bootstrap", "--runtime-parameter", RUNTIME_ARN, "--environment", "staging", "--primary-pool", "p1", "--generation", "1", "--by", "x"], deps({ [RUNTIME_ARN]: bad }, lines));
    assert.equal(code, EXIT_USAGE, lines.join("\n"));
    assert.ok(lines.some((l) => /unknown field rpc_api_key/.test(l)), lines.join("\n"));
    assert.ok(!lines.some((l) => l.includes("not-allowed")), "a document's values are never echoed");
  });
});
