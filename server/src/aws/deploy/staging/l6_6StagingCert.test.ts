// server/src/aws/deploy/staging/l6_6StagingCert.test.ts
//
// ==================================================================
//  LIVE-6 L6-6: THE STAGING CERTIFICATION HARNESS, CHECKED WITHOUT AWS (`npm test`)
// ==================================================================
//
// No credential, no network beyond loopback, no deployment: the probes run against fakes that behave as the real services
// answer (an IAM-enforcing DynamoDB, a KMS that signs with known keys, the edge diagnostic behind a proxy chain that
// appends X-Forwarded-For), and the certification is judged over a fixture evidence directory built from L5-8's own
// control-plane fixtures. What must hold:
//
//   §1 every required gate contributes to the verdict; a complete, good package is PASS; breaking any gate's evidence
//      FAILS that gate by id; a gate not required says so and is never counted as a pass;
//   §2 omitted or skipped evidence is FAIL, never PASS (a missing file, a not-run probe, a verifier SKIP);
//   §3 Terraform: a destructive or replacing plan FAILS; a skip_destroy task-definition revision does not; the lock, the
//      exit status, the gate on the bootstrap;
//   §4 the prerequisite: a wrong running task definition, a deployment in progress, a task beside the service, an
//      unhealthy or foreign target, a moved deployment -- each FAILS;
//   §5 the edge: an allow-list of cp/cr/cb FAILS by name; a wrong hop count, a spoofed key, the ALB probed directly;
//   §6 IAM: expected denial vs unexpected authority vs another principal vs malformed vs infrastructure;
//   §7 transactions: TransactionConflict classified; no conflict observed, a broken invariant, a leftover item FAIL;
//   §8 KMS: > 3 s FAILS, < 3 s passes, an invalid answer FAILS;
//   §9 the WebSocket paths, parsed: the announcement answer, idle survival, pings, who closed it;
//   §10 secrets are refused (writer and reader), the session cookie never lands in a record, the report is deterministic;
//   §11 no probe can reach production authority: the disposable guard, the IAM guard, KMS touches no store, the edge
//       diagnostic is a pure mirror and exists only where the switch says; the certifier task can never be the server.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";

import { WebSocketServer } from "ws";

import { addressOfPublicKey } from "../../../escrow/juno/cosmosTx";
import { parseJunoBackendConfig } from "../../../escrow/juno/junoConfig";
import { bigIntTo32, bytesToBigInt, decompressPublicKey, publicKeyOf, SECP256K1_N, signDigest } from "../../../escrow/juno/secp256k1";
import { edgeDiagnosticAnswer, edgeDiagnosticSwitch, EDGE_DIAGNOSTIC_FORMAT, handleEdgeDiagnostic } from "../../../ingress/edgeDiagnostic";
import { classifyTransactFailure } from "../../game/transact";
import { loadAwsStartup } from "../../runtime/awsMain";
import type { ParameterSource } from "../../runtime/configSource";
import { runDeployCommand, EXIT_USAGE, type DeployDeps } from "../commands";
import { CACHING_DISABLED_POLICY_ID, checkEdgeEvidence, checkEvidenceDirectory, EVIDENCE_FILES, type Check } from "../deployVerify";
import { ALARM_CONTRACT, expectedAlarms, suppressorName } from "../../controlPlane/alarmContract";
import { POOL_EVIDENCE_FILES } from "../../controlPlane/evidence";
import { certify, CERTIFIER_STORAGE_OVERRIDE, certificationText, clearCertification, judgeCertifierTask, prerequisiteChecks, prerequisiteRecord, repositoryHead, VERDICT_LINE, writeCertification, type CertContext } from "./certify";
import { stageCertCommand, stageProbeCommand, recordFromLog, recordLines, type StagingDeps } from "./commands";
import { closedBy, judgeQueryProbe, judgeWsAnnouncement, judgeWsIdle, LOBBY_SUBSCRIPTION, nodeEdgeTransport, probeQuery, requiredIdleMs, runEdgeProbe, type EdgeTransport, type SocketEvent, type SocketObservation } from "./edgeProbe";
import { CERTIFICATION_FORMAT, EVIDENCE, evidenceName, EvidenceRefusedError, manifestOf, obj, readEvidence, secretFindings, stableStringify, writeRecord } from "./evidence";
import { DRAIN_FILES, drainDir } from "./drain";
import { caseFoldCollisions, readCheckoutText, toPosixPath, withDirectories } from "../../../testSupport/portability";
import { classifyIamAnswer, IAM_PROBE_IDS, iamProbeSpecs, iamProbeWriteProblem, judgeIamProbe, runIamProbe, type IamAnswer } from "./iamProbe";
import { judgeKmsProbe, KMS_LATENCY_BOUND_MS, runKmsProbe } from "./kmsProbe";
import { judgeTerraformStack, AWS_PROVIDER, TERRAFORM_FILES } from "./terraformPlan";
import { disposableOnly, DisposableGuardError, judgeTransactionProbe, runTransactionProbe } from "./transactionProbe";
import { checkClusterTasks, CLUSTER_LISTING_WINDOW_MS, CLUSTER_TASKS_FORMAT, DESCRIBE_TASKS_BATCH_MAX, DESCRIBE_TASKS_BATCH, readClusterListing } from "./prerequisite";
import { buildCapabilities, PRIOR_CERTIFICATIONS, readGenerationEvidence, readIdentityRecovery, RESTORE_FENCING_CASES, RESTORE_FENCING_FILE, RESTORE_STOP_DIR, revisionsFile, type AdoptionRecordFacts, type AppGenerationFacts, type GenerationEvidence, type GenerationMarkerFacts, type IdentityRestoreFacts, type RecoveryReaders, type ReviewSummary } from "./recovery";

const REPO = path.resolve(__dirname, "../../../../../../.."); // dist/server/src/aws/deploy/staging -> the repository
const INFRA = path.join(REPO, "infra/aws");
const fixture = (name: string) => fs.readFileSync(path.join(INFRA, "fixtures", name), "utf8");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const failures = (checks: readonly Check[]) => checks.filter((c) => c.status !== "pass");

const RUN = "l6cert-test-0930";
const RUNTIME_ARN = "arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/runtime/p1";
const JUNO_ARN = "arn:aws:ssm:us-east-1:111111111111:parameter/gs/staging/juno-backend";
const TD = "arn:aws:ecs:us-east-1:111111111111:task-definition/gs-staging-p1:7";
/* LIVE-6 final convergence: L6-2's layout -- one target group per pool (gs-<env>-<pool>), /gs* to the primary's. */
const TG_ARN = "arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/gs-staging-p1/0123456789abcdef";
const TASK = "arn:aws:ecs:us-east-1:111111111111:task/gs-staging/0aaa1111bbbb2222cccc3333dddd4444";
const TASK_IP = "10.0.1.23";
const CERTIFIER_TASK = "arn:aws:ecs:us-east-1:111111111111:task/gs-staging/9fff0000aaaa1111bbbb2222cccc3333";
const HEAD = repositoryHead(REPO) ?? "unreadable";
const IMAGE = "111111111111.dkr.ecr.us-east-1.amazonaws.com/gs-staging-server:2026-09-30-test";
const DIGEST = `sha256:${"d1".repeat(32)}`;

/* ------------------------------------------------------------------ */
/* L6-4's readers, as the integration binds them (fakes answering parsed shapes) */
/* ------------------------------------------------------------------ */

const BOOT_MARKER: GenerationMarkerFacts = { generation: 1, game_table: "gs-staging-game-g1", origin: "bootstrap", restored_from_generation: null, restored_from_table: null, restore_point: null, restore_id: null, prepared_at: 1, prepared_by: "boot", claim: "11111111-1111-4111-8111-111111111111" };
const BOOT_APPGEN: AppGenerationFacts = { current_generation: 1, adoption: null };
const RESTORED_MARKER: GenerationMarkerFacts = { ...BOOT_MARKER, generation: 2, game_table: "gs-staging-game-g2", origin: "restore", restored_from_generation: 1, restored_from_table: "gs-staging-game-g1", restore_point: 5, restore_id: "drill-0930" };
const ADOPTED: AppGenerationFacts = { current_generation: 2, adoption: { previous_generation: 1, adopted_at: Date.parse("2026-09-30T09:40:00Z"), adopted_by: "op", restore_id: "drill-0930", game_table: "gs-staging-game-g2", claim: "22222222-2222-4222-8222-222222222222" } };
const IDENTITY_TABLE = "gs-staging-identity";

interface ReaderScript {
  readonly marker?: GenerationMarkerFacts | null | Error;
  readonly appgen?: AppGenerationFacts | null | Error;
  /** L6-4's own startup rule's answer (default: none -- the fake binds no L6-4 code; each direction is tested). */
  readonly startup?: string | null | Error;
  readonly restore?: IdentityRestoreFacts | null;
  readonly self?: string | null;
  readonly servingProblem?: string | null;
  readonly reviews?: readonly ReviewSummary[] | Error;
  /** APPGEN#HISTORY/GEN#<n> (default: the adoption APPGEN names, as its one transaction wrote it). */
  readonly history?: AdoptionRecordFacts | null | Error;
}
const answer = <T>(value: T | Error): Promise<T> => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
const readersFor = (script: ReaderScript = {}): RecoveryReaders => ({
  generationMarker: async () => answer(script.marker === undefined ? BOOT_MARKER : script.marker),
  appGeneration: async () => answer(script.appgen === undefined ? BOOT_APPGEN : script.appgen),
  generationServingProblem: () => {
    if (script.startup instanceof Error) throw script.startup;
    return script.startup ?? null;
  },
  identityState: async () => ({ restore: script.restore ?? null, self: script.self === undefined ? IDENTITY_TABLE : script.self, servingProblem: script.servingProblem ?? null }),
  reviews: async () => answer(script.reviews ?? []),
  adoptionRecord: async (_client, _table, generation) => {
    if (script.history !== undefined) return answer(script.history);
    const a = script.appgen === undefined ? BOOT_APPGEN : script.appgen;
    return a instanceof Error || a === null || a.adoption === null || a.current_generation !== generation ? null : { generation, ...a.adoption };
  },
});
const generationOf = (script: ReaderScript = {}): Promise<GenerationEvidence> => readGenerationEvidence(readersFor(script), { app: {} as never, ledger: {} as never }, { game: "gs-staging-game-g1", ledger: "arn:l" });
const ALL_L64 = { generation_marker: true, app_generation: true, identity_restore: true, security_replay: true };

/* ------------------------------------------------------------------ */
/* Keys this test controls (the KMS stand-in signs with them)           */
/* ------------------------------------------------------------------ */

const SECRETS: Record<string, Buffer> = {
  "arn:aws:kms:us-east-1:222222222222:key/11111111-1111-4111-8111-111111111111": Buffer.alloc(32, 0x11),
  "arn:aws:kms:us-east-1:222222222222:key/22222222-2222-4222-8222-222222222222": Buffer.alloc(32, 0x12),
  "arn:aws:kms:us-east-1:222222222222:key/33333333-3333-4333-8333-333333333333": Buffer.alloc(32, 0x13),
};
const pub = (arn: string) => publicKeyOf(SECRETS[arn]);
const [RELAYER_KEY, SETTLEMENT_KEY, ADMISSION_KEY] = Object.keys(SECRETS);

/** The staging Juno configuration, re-keyed to the keys above. */
function junoText(): string {
  const doc = JSON.parse(fixture("juno-backend-staging.json")) as Record<string, any>;
  doc.relayer.address = addressOfPublicKey(pub(RELAYER_KEY), "juno");
  doc.settlement_key.public_key_hex = pub(SETTLEMENT_KEY).toString("hex");
  doc.admission_key.public_key_hex = pub(ADMISSION_KEY).toString("hex");
  if (Array.isArray(doc.trust?.operators)) doc.trust.operators = [doc.relayer.address];
  return JSON.stringify(doc);
}
const junoConfig = () => parseJunoBackendConfig(JSON.parse(junoText()), { serverMode: "production", dataDir: "/nonexistent" });

const SPKI_PREFIX = Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex");
const spkiOf = (compressed: Buffer): Uint8Array => {
  const { x, y } = decompressPublicKey(compressed);
  return Buffer.concat([SPKI_PREFIX, Buffer.from([4]), bigIntTo32(x), bigIntTo32(y)]);
};
const derInteger = (value: Buffer): Buffer => {
  let body = value;
  while (body.length > 1 && body[0] === 0 && !(body[1] & 0x80)) body = body.subarray(1);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return Buffer.concat([Buffer.from([0x02, body.length]), body]);
};
const derOf = (compact: Buffer, highS = false): Buffer => {
  const s = highS ? bigIntTo32(SECP256K1_N - bytesToBigInt(compact.subarray(32))) : compact.subarray(32);
  const body = Buffer.concat([derInteger(compact.subarray(0, 32)), derInteger(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
};

/** A KMS client (the `KmsClient` port) that signs with the keys above; `tamper` corrupts an answer; `latency` per Sign. */
function fakeKms(options: { readonly latencyMs?: (arn: string, i: number) => number; readonly tamper?: (arn: string, der: Buffer) => Uint8Array; readonly clock?: { now: number } } = {}) {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  return {
    calls,
    client: {
      async getPublicKey(arn: string) {
        calls.push(`GetPublicKey ${arn}`);
        return spkiOf(pub(arn));
      },
      async signDigest(arn: string, digest: Uint8Array) {
        calls.push(`Sign ${arn}`);
        const i = counts.get(arn) ?? 0;
        counts.set(arn, i + 1);
        if (options.clock !== undefined) options.clock.now += options.latencyMs?.(arn, i) ?? 100;
        const der = derOf(signDigest(SECRETS[arn], digest), i % 2 === 1);
        return options.tamper?.(arn, der) ?? der;
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* An IAM-enforcing DynamoDB stand-in (for the IAM probe)               */
/* ------------------------------------------------------------------ */

type Sent = { readonly name: string; readonly input: Record<string, any> };

/** Answers as real DynamoDB does for the IAM probe's shapes: IAM first (the task role's policy), then the condition. */
function iamDynamo(options: { readonly enforce: boolean; readonly role?: string; readonly allowSystemPut?: boolean }) {
  const sent: Sent[] = [];
  const denied = (action: string) =>
    Object.assign(new Error(`User: arn:aws:sts::111111111111:assumed-role/${options.role ?? "gs-staging-app-task"}/t-0123 is not authorized to perform: dynamodb:${action} on resource: arn:aws:dynamodb:us-east-1:111111111111:table/x because no identity-based policy allows the dynamodb:${action} action`), { name: "AccessDeniedException" });
  const ledger = (table: string) => table.startsWith("arn:");
  const forbidden = (table: string, kind: string, pk: string): string | null => {
    if (!options.enforce) return null;
    if (ledger(table)) {
      if (kind === "Update") return "UpdateItem";
      if (kind === "Delete") return "DeleteItem";
      if (kind === "Put" && pk === "APPGEN") return "PutItem";
      return null;
    }
    if (pk === "SYSTEM" && kind !== "ConditionCheck" && !(options.allowSystemPut === true && kind === "Put")) return `${kind}Item`;
    return null;
  };
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, any> }) {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "PutItemCommand") {
        const why = forbidden(command.input.TableName, "Put", command.input.Item.pk.S);
        if (why !== null) throw denied(why);
        throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
      }
      if (command.constructor.name === "TransactWriteItemsCommand") {
        const items = command.input.TransactItems as Array<Record<string, any>>;
        for (const item of items) {
          const [kind, action] = Object.entries(item)[0] as [string, Record<string, any>];
          const k = kind === "Put" ? action.Item : action.Key;
          const why = forbidden(action.TableName, kind, k.pk.S);
          if (why !== null) throw denied(why);
        }
        const reasons = items.map((item) => {
          const [kind, action] = Object.entries(item)[0] as [string, Record<string, any>];
          return { Code: kind === "ConditionCheck" && action.ConditionExpression === "attribute_exists(pk)" ? "None" : "ConditionalCheckFailed" };
        });
        throw Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: reasons });
      }
      throw new Error(`unexpected ${command.constructor.name}`);
    },
  };
  return { client: client as never, sent };
}

/* ------------------------------------------------------------------ */
/* The edge stand-in: the diagnostic behind CloudFront + ALB            */
/* ------------------------------------------------------------------ */

const VIEWER_IP = "203.0.113.77";
const CLOUDFRONT_IP = "130.176.0.10";

interface FakeEdgeOptions {
  /** Which query parameters the "edge" forwards (null: all -- the contract). */
  readonly allowList?: readonly string[] | null;
  /** How many entries the path appends to X-Forwarded-For (2: CloudFront and the ALB). */
  readonly appended?: number;
  readonly hops?: number;
  readonly idle?: (hold: number) => SocketObservation;
  readonly refused?: () => SocketObservation;
  readonly diagnosticMissing?: boolean;
}

const pingsUntil = (end: number, every = 25_000): SocketEvent[] => {
  const out: SocketEvent[] = [];
  for (let t = every; t < end; t += every) out.push({ at_ms: t, kind: "ping" });
  return out;
};

function fakeEdge(options: FakeEdgeOptions = {}): EdgeTransport & { readonly urls: string[]; readonly headers: Array<Record<string, string>>; readonly sends: Array<readonly [string, string | undefined]> } {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const sends: Array<readonly [string, string | undefined]> = [];
  /* As the Node transport does: a frame sent on open is recorded first, as a `sent` event. */
  const withSent = (o: SocketObservation, frame: string | undefined): SocketObservation =>
    frame === undefined || !o.opened ? o : { ...o, events: [{ at_ms: 0, kind: "sent", frame_kind: String((JSON.parse(frame) as { kind?: unknown }).kind) }, ...o.events] };
  return {
    urls,
    headers,
    sends,
    async get(url, h) {
      urls.push(url);
      headers.push({ ...h });
      if (options.diagnosticMissing === true) return { status: 200, body: "1830 game server\n" };
      const u = new URL(url);
      let query = u.search.slice(1);
      if (options.allowList !== undefined && options.allowList !== null) {
        const params = new URLSearchParams(query);
        query = [...params].filter(([n]) => options.allowList?.includes(n)).map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join("&");
      }
      const appended = [VIEWER_IP, CLOUDFRONT_IP, "10.0.0.9"].slice(0, options.appended ?? 2);
      const xff = [...(h["X-Forwarded-For"] ?? "").split(",").map((x) => x.trim()).filter((x) => x !== ""), ...appended].join(", ");
      const answer = edgeDiagnosticAnswer({ url: `${u.pathname}${query === "" ? "" : `?${query}`}`, headers: { "x-forwarded-for": xff }, socket: { remoteAddress: "10.0.0.9" } } as never, options.hops ?? 2);
      return { status: 200, body: JSON.stringify(answer) };
    },
    async observeSocket(url, h, hold, sendOnOpen) {
      urls.push(url);
      headers.push({ ...h });
      sends.push([url, sendOnOpen]);
      if (new URL(url).searchParams.get("cp") === "9") {
        return withSent(options.refused?.() ?? { upgrade_status: null, opened: true, events: [{ at_ms: 40, kind: "message", frame_kind: "reload", frame_code: "client-protocol" }, { at_ms: 41, kind: "close", code: 4426, clean: true }], ended_by: "remote", duration_ms: 41 }, sendOnOpen);
      }
      return withSent(options.idle?.(hold) ?? { upgrade_status: null, opened: true, events: [...pingsUntil(hold), { at_ms: hold, kind: "close", code: 1000, clean: true }], ended_by: "probe", duration_ms: hold }, sendOnOpen);
    },
  };
}

/* ------------------------------------------------------------------ */
/* The fixture evidence directory                                       */
/* ------------------------------------------------------------------ */

const SERVICES = {
  services: [
    {
      serviceName: "gs-staging-p1",
      desiredCount: 1,
      runningCount: 1,
      pendingCount: 0,
      taskDefinition: TD,
      deployments: [{ status: "PRIMARY", taskDefinition: TD, rolloutState: "COMPLETED" }],
      deploymentConfiguration: { minimumHealthyPercent: 0, maximumPercent: 100, deploymentCircuitBreaker: { enable: true, rollback: true } },
      availabilityZoneRebalancing: "DISABLED",
      enableExecuteCommand: false,
      networkConfiguration: { awsvpcConfiguration: { assignPublicIp: "DISABLED" } },
      loadBalancers: [{ targetGroupArn: TG_ARN, containerName: "game-server", containerPort: 8917 }],
    },
  ],
};
const TASK_DEFINITION = {
  taskDefinition: {
    taskDefinitionArn: TD,
    family: "gs-staging-p1",
    networkMode: "awsvpc",
    taskRoleArn: "arn:aws:iam::111111111111:role/gs-staging-app-task",
    containerDefinitions: [
      {
        name: "game-server",
        image: IMAGE,
        portMappings: [{ containerPort: 8917, hostPort: 8917, protocol: "tcp" }],
        environment: [
          { name: "GS_MODE", value: "production" },
          { name: "GS_STORAGE", value: "aws" },
          { name: "GS_AWS_CONFIG_PARAMETER", value: RUNTIME_ARN },
          { name: "BUILD_ID", value: "2026-09-30-test" },
          { name: "PORT", value: "8917" },
          { name: "GS_ALLOWED_ORIGINS", value: "https://play.example.com" },
          { name: "GS_TRUSTED_PROXY_HOPS", value: "2" },
          { name: "GS_EDGE_DIAGNOSTIC", value: "staging" },
        ],
        stopTimeout: 120,
        healthCheck: { command: ["CMD", "node", "-e", "require('http').get('http://127.0.0.1:'+process.env.PORT+'/gs/healthz',...)"] },
        logConfiguration: { logDriver: "awslogs", options: {} },
      },
    ],
  },
};
const RUNNING_TASKS = {
  tasks: [
    {
      taskArn: TASK,
      group: "service:gs-staging-p1",
      lastStatus: "RUNNING",
      desiredStatus: "RUNNING",
      taskDefinitionArn: TD,
      createdAt: "2026-09-30T09:00:00.000000+00:00",
      attachments: [{ type: "ElasticNetworkInterface", details: [{ name: "privateIPv4Address", value: TASK_IP }] }],
      containers: [{ name: "game-server", lastStatus: "RUNNING", imageDigest: DIGEST }],
    },
  ],
  failures: [],
};
/** L6-6P: capture-evidence's complete cluster listing over `tasks` -- desired RUNNING and desired STOPPED, `pageSize`
 *  ARNs per list-tasks page, every distinct ARN described in batches of DESCRIBE_TASKS_BATCH (50, LIVE-6 W1) -- exactly the
 *  shape the scripts write. */
const CLUSTER_LISTED_AT = "2026-09-30T10:29:40Z";
function clusterListing(tasks: readonly Record<string, unknown>[], options: { readonly pageSize?: number; readonly listedAt?: string; readonly alsoListedRunning?: readonly string[] } = {}) {
  const size = options.pageSize ?? 100;
  const pagesOf = (arns: readonly string[]) => {
    const pages: Array<{ page: number; task_arns: string[]; more: boolean }> = [];
    for (let i = 0; i === 0 || i < arns.length; i += size) pages.push({ page: pages.length, task_arns: arns.slice(i, i + size), more: i + size < arns.length });
    return pages;
  };
  const running = [...tasks.filter((t) => t.desiredStatus === "RUNNING").map((t) => String(t.taskArn)), ...(options.alsoListedRunning ?? [])];
  const stopped = tasks.filter((t) => t.desiredStatus !== "RUNNING").map((t) => String(t.taskArn));
  const batches: Array<{ tasks: Record<string, unknown>[]; failures: unknown[] }> = [];
  for (let i = 0; i < tasks.length; i += DESCRIBE_TASKS_BATCH) batches.push({ tasks: tasks.slice(i, i + DESCRIBE_TASKS_BATCH).map(clone), failures: [] });
  return {
    format: "18COSMOS/L6-6P-CLUSTER-TASKS/v1",
    cluster: "gs-staging",
    listed_at: options.listedAt ?? CLUSTER_LISTED_AT,
    listings: [
      { desired_status: "RUNNING", pages: pagesOf(running) },
      { desired_status: "STOPPED", pages: pagesOf(stopped) },
    ],
    task_count: new Set([...running, ...stopped]).size,
    batches,
  };
}
/** A terminal task ECS still reports (the certifier task ends this way; an old deployment's tasks linger ~1 h). */
const stoppedTask = (i: number, extra: Record<string, unknown> = {}) => ({
  taskArn: `arn:aws:ecs:us-east-1:111111111111:task/gs-staging/${i.toString(16).padStart(32, "0")}`,
  group: "service:gs-staging-p1",
  lastStatus: "STOPPED",
  desiredStatus: "STOPPED",
  taskDefinitionArn: TD.replace(":7", ":6"),
  ...extra,
});
const CERTIFIER_STOPPED = { taskArn: CERTIFIER_TASK, group: "family:gs-staging-p1", lastStatus: "STOPPED", desiredStatus: "STOPPED", taskDefinitionArn: TD };
const CLUSTER_TASKS = clusterListing([...RUNNING_TASKS.tasks, CERTIFIER_STOPPED]);
const ORP_ID = "a1b2c3d4-0000-4000-8000-000000000001";
const DISTRIBUTION = {
  DistributionConfig: {
    Aliases: { Quantity: 1, Items: ["play.example.com"] },
    Origins: {
      Items: [
        { Id: "site", DomainName: "site-origin.example.com", CustomOriginConfig: { OriginProtocolPolicy: "https-only", OriginReadTimeout: 30 } },
        { Id: "gs-alb", DomainName: "gs-origin.example.com", CustomOriginConfig: { OriginProtocolPolicy: "https-only", OriginReadTimeout: 60 } },
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
    { GroupName: "gs-staging-alb", GroupId: "sg-alb", IpPermissions: [{ IpProtocol: "tcp", FromPort: 443, ToPort: 443, PrefixListIds: [{ PrefixListId: "pl-cloudfront" }], IpRanges: [], Ipv6Ranges: [], UserIdGroupPairs: [] }] },
    { GroupName: "gs-staging-task", GroupId: "sg-task", IpPermissions: [{ IpProtocol: "tcp", FromPort: 8917, ToPort: 8917, UserIdGroupPairs: [{ GroupId: "sg-alb" }], IpRanges: [], Ipv6Ranges: [], PrefixListIds: [] }] },
  ],
};
const TARGET_GROUPS = { TargetGroups: [{ TargetGroupArn: TG_ARN, TargetGroupName: "gs-staging-p1", HealthCheckPath: "/gs/readyz", Matcher: { HttpCode: "200" }, TargetType: "ip" }] };
const LISTENER_RULES = {
  Rules: [
    { Priority: "100", Conditions: [{ Field: "path-pattern", Values: ["/gs/p/p1"], PathPatternConfig: { Values: ["/gs/p/p1"] } }], Actions: [{ Type: "forward", TargetGroupArn: TG_ARN }] },
    { Priority: "1000", Conditions: [{ Field: "path-pattern", Values: ["/gs*"], PathPatternConfig: { Values: ["/gs*"] } }], Actions: [{ Type: "forward", TargetGroupArn: TG_ARN }] },
    { Priority: "default", IsDefault: true, Conditions: [], Actions: [{ Type: "fixed-response" }] },
  ],
};

/** LIVE-6 final convergence: a describe-alarms answer exactly as alarms.tf renders the L6-5B contract (the l6_5bAlarms
 *  suite's renderer, plus each alarm's ARN -- its stable identity). Empty action lists: a valid staging answer. */
function renderAlarms(shape: { readonly environment: string; readonly pools: readonly string[]; readonly primaryPool: string; readonly escrow: boolean }, actions: { readonly page: readonly string[]; readonly ticket: readonly string[] } = { page: [], ticket: [] }) {
  const arnOf = (name: string) => `arn:aws:cloudwatch:us-east-1:111111111111:alarm:${name}`;
  const listOf = (cls: string) => [...(cls === "page" ? actions.page : actions.ticket)];
  const expected = expectedAlarms({ ...shape, services: true });
  return {
    MetricAlarms: [
      ...expected.map((e) => ({
        AlarmName: e.name,
        AlarmArn: arnOf(e.name),
        ActionsEnabled: true,
        AlarmActions: e.spec.suppressible ? [] : listOf(e.spec.class),
        OKActions: e.spec.suppressible ? [] : listOf(e.spec.class),
        InsufficientDataActions: [],
        StateValue: "OK",
        EvaluationPeriods: e.spec.evaluation_periods,
        DatapointsToAlarm: e.spec.datapoints_to_alarm,
        Threshold: e.spec.threshold,
        ComparisonOperator: e.spec.comparison,
        TreatMissingData: e.spec.missing,
        Metrics: [
          ...e.spec.metrics.map((m) => ({
            Id: m.id,
            MetricStat: { Metric: { Namespace: ALARM_CONTRACT.namespace, MetricName: m.metric, Dimensions: [{ Name: "Environment", Value: shape.environment }, ...(e.pool === null ? [] : [{ Name: "Pool", Value: e.pool }])] }, Period: e.spec.period, Stat: m.stat },
            ReturnData: e.spec.expression === null,
          })),
          ...(e.spec.expression === null ? [] : [{ Id: "e1", Expression: e.spec.expression, Label: e.spec.id, ReturnData: true }]),
        ],
      })),
      ...shape.pools.map((pool) => ({
        AlarmName: suppressorName(shape.environment, pool),
        AlarmArn: arnOf(suppressorName(shape.environment, pool)),
        ActionsEnabled: true,
        AlarmActions: [],
        OKActions: [],
        StateValue: "OK",
        Namespace: "18Cosmos/Operator",
        MetricName: "FlipWindowOpen",
        Statistic: "Sum",
        Period: 60,
        EvaluationPeriods: 1,
        Threshold: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        TreatMissingData: "notBreaching",
        Dimensions: [{ Name: "Environment", Value: shape.environment }, { Name: "Pool", Value: pool }],
      })),
    ],
    CompositeAlarms: expected
      .filter((e) => e.spec.suppressible)
      .map((e) => ({
        AlarmName: `${e.name}-notify`,
        AlarmArn: arnOf(`${e.name}-notify`),
        AlarmRule: `ALARM("${e.name}")`,
        ActionsEnabled: true,
        AlarmActions: listOf(e.spec.class),
        OKActions: listOf(e.spec.class),
        StateValue: "OK",
        ActionsSuppressor: suppressorName(shape.environment, e.pool as string),
        ActionsSuppressorWaitPeriod: 120,
        ActionsSuppressorExtensionPeriod: 120,
      })),
  };
}
const ALARMS = renderAlarms({ environment: "staging", pools: ["p1"], primaryPool: "p1", escrow: true });

const PARAMETERS: ParameterSource = {
  async read(arn) {
    const docs: Record<string, string> = { [RUNTIME_ARN]: fixture("runtime-staging-p1.json"), [JUNO_ARN]: junoText() };
    const value = docs[arn];
    if (value === undefined) throw new Error(`no parameter ${arn}`);
    return { value, version: 3, arn };
  },
};
const startupOf = () => loadAwsStartup({ argv: [], env: { GS_AWS_CONFIG_PARAMETER: RUNTIME_ARN }, serverMode: "production", parameters: PARAMETERS });

const TIMES = { prerequisite: "2026-09-30T10:00:00.000Z", taskStart: "2026-09-30T10:05:00.000Z", taskEnd: "2026-09-30T10:07:00.000Z", edgeStart: "2026-09-30T10:10:00.000Z", edgeEnd: "2026-09-30T10:16:10.000Z", capture: "2026-09-30T10:30:00Z" };

const write = (dir: string, file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), typeof value === "string" ? value : JSON.stringify(value, null, 2), "utf8");
};

/** A passing transaction-probe result, exactly as `runTransactionProbe` records one. */
const TRANSACTIONS = {
  t1: { setup: { kind: "applied", redone: false }, probe: { kind: "refused", resend: false, reasons: ["ConditionalCheckFailed", "None"], old_v: [1, null] }, b_present: false },
  t2: { setup: { kind: "applied", redone: false }, a: { kind: "applied", redone: false }, b: { kind: "refused", resend: false, reasons: ["ConditionalCheckFailed"], old_v: [null] }, final_v: 2, final_w: "a" },
  t3: { setup: { kind: "applied", redone: false }, rounds: 20, writers: 6, applied: 71, conflicts: 49, conflicts_classified_not_applied: 49, other: {}, final_n: 71 },
  t4: {
    setup: { kind: "applied", redone: false },
    original: "applied",
    same_token_resend: { kind: "applied", redone: false },
    new_token_control: { kind: "refused", resend: false, reasons: ["ConditionalCheckFailed"], old_v: [null] },
    mismatch: "IdempotentParameterMismatchException",
    mismatch_engine_class: "unknown",
    refused_original: "TransactionCanceledException",
    refused_resend: { kind: "refused", resend: false, reasons: ["ConditionalCheckFailed"], old_v: [null] },
    final_v: 2,
    final_n: 1,
  },
  cleanup: { deleted: 5, remaining: 0, errors: [] },
  errors: [],
};

const TERRAFORM_VERSION = { terraform_version: "1.16.4", platform: "linux_amd64", provider_selections: { [AWS_PROVIDER]: "6.66.0" }, terraform_outdated: false };
/* The committed lock, as committed (LF): a Windows checkout's is CRLF, and a mutation written against `\n` would silently
   not apply to it (LIVE-6 W1). `edited` refuses a mutation that changed nothing -- it would prove nothing. */
const lockText = (stack: string) => readCheckoutText(path.join(INFRA, "stacks", stack, ".terraform.lock.hcl"));
function edited(text: string, from: string | RegExp, to: string): string {
  const out = text.replace(from, to);
  assert.notEqual(out, text, `the mutation ${String(from)} applied`);
  return out;
}
const ledgerPlan = () => ({
  format_version: "1.2",
  terraform_version: "1.16.4",
  timestamp: "2026-09-30T10:20:00Z",
  variables: {},
  resource_changes: [
    { address: "module.ledger.aws_dynamodb_table.ledger", mode: "managed", type: "aws_dynamodb_table", change: { actions: ["no-op"], before: {}, after: {} } },
    { address: "module.ledger.aws_kms_key.signing[\"relayer\"]", mode: "managed", type: "aws_kms_key", change: { actions: ["update"], before: {}, after: {} } },
  ],
  prior_state: { values: { root_module: { child_modules: [] } } },
  errored: false,
});
const service = (actions: string[], after: Record<string, unknown> = {}) => ({
  address: "module.app.aws_ecs_service.pool[\"p1\"]",
  mode: "managed",
  type: "aws_ecs_service",
  change: { actions, before: null, after: { deployment_minimum_healthy_percent: 0, deployment_maximum_percent: 100, desired_count: 1, availability_zone_rebalancing: "DISABLED", ...after } },
});
const appPlan = (overrides: { start?: boolean; routing?: unknown; extra?: unknown[]; deferred?: boolean } = {}) => ({
  format_version: "1.2",
  terraform_version: "1.16.4",
  timestamp: "2026-09-30T10:21:00Z",
  variables: { start_services: { value: overrides.start ?? true } },
  resource_changes: [
    { address: "module.app.aws_dynamodb_table.game", mode: "managed", type: "aws_dynamodb_table", change: { actions: ["no-op"], before: {}, after: {} } },
    { address: "module.app.aws_ecs_task_definition.pool[\"p1\"]", mode: "managed", type: "aws_ecs_task_definition", change: { actions: ["create", "delete"], before: { skip_destroy: true }, after: { skip_destroy: true } }, action_reason: "replace_because_cannot_update" },
    service(["create"]),
    ...(overrides.deferred === true ? [{ address: "module.app.data.aws_dynamodb_table_item.routing[0]", mode: "data", type: "aws_dynamodb_table_item", change: { actions: ["read"], before: null, after: {} } }] : []),
    ...((overrides.extra ?? []) as unknown[]),
  ],
  prior_state: {
    values: {
      root_module: {
        child_modules: [
          {
            address: "module.app",
            resources: overrides.deferred === true ? [] : [{ address: "module.app.data.aws_dynamodb_table_item.routing[0]", mode: "data", type: "aws_dynamodb_table_item", values: { item: JSON.stringify(overrides.routing ?? { pk: { S: "SYSTEM" }, sk: { S: "ROUTING" }, fmt: { N: "1" }, primary_pool: { S: "p1" }, routing_version: { N: "1" } }) } }],
          },
        ],
      },
    },
  },
  errored: false,
});

const LEDGER_RECORD = { format: "18COSMOS/L5-8-VERIFY/v1", run_id: RUN, part: "ledger", environment: "staging", generation: 1, at: "2026-09-30T09:59:00.000Z", verdict: "PASS", checks: [{ name: "ledger table: PITR", status: "pass", detail: "ENABLED" }] };

async function taskRoleRecord(overrides: { kms?: unknown; iam?: unknown; transactions?: unknown; runner?: Record<string, unknown>; identity?: ReaderScript | null } = {}) {
  const iam = await runIamProbe({ game: iamDynamo({ enforce: true }).client, ledger: iamDynamo({ enforce: true }).client }, { run: RUN, gameTable: "gs-staging-game-g1", ledgerTable: "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger", nonce: "n0nce" });
  const clock = { now: 0 };
  const kms = await runKmsProbe(junoConfig(), { kms: fakeKms({ clock }).client, clock: () => clock.now }, { run: RUN, samples: 3 });
  return {
    format: "18COSMOS/L6-6-PROBE/v1",
    probe: "task-role",
    run_id: RUN,
    environment: "staging",
    generation: 1,
    pool: "p1",
    started_at: TIMES.taskStart,
    finished_at: TIMES.taskEnd,
    runner: { ecs_task: true, task_arn: CERTIFIER_TASK, build_id: "2026-09-30-test", build_capabilities: ALL_L64, runtime_parameter_matches_env: true, ...(overrides.runner ?? {}) },
    runtime_document_version: 3,
    sections: {
      iam: overrides.iam ?? { status: "ran", ...iam },
      kms: overrides.kms ?? { status: "ran", results: kms },
      transactions: overrides.transactions ?? { status: "ran", partition: `L6CERT#${RUN}`, results: TRANSACTIONS },
      identity_state: await readIdentityRecovery(overrides.identity === null ? undefined : readersFor(overrides.identity ?? {}), {} as never, IDENTITY_TABLE),
    },
  };
}

async function edgeRecord(transport: EdgeTransport = fakeEdge(), options: { expectedClientIp?: string | null; cookie?: string | null } = {}) {
  const required = requiredIdleMs(300, 60);
  const sections = await runEdgeProbe(transport, {
    run: RUN,
    baseUrl: "https://play.example.com",
    origin: "https://play.example.com",
    sessionCookie: options.cookie === undefined ? "v1.sessionid00.secretsecretsecretsecret" : options.cookie,
    expectedClientIp: options.expectedClientIp === undefined ? VIEWER_IP : options.expectedClientIp,
    albIdleSeconds: 300,
    originReadTimeoutSeconds: 60,
    holdMs: required + 10_000,
  });
  return { format: "18COSMOS/L6-6-PROBE/v1", probe: "edge", run_id: RUN, environment: "staging", generation: 1, pool: "p1", started_at: TIMES.edgeStart, finished_at: TIMES.edgeEnd, sections };
}

const CERTIFIER_RUN = {
  tasks: [
    {
      taskArn: CERTIFIER_TASK,
      taskDefinitionArn: TD,
      group: "family:gs-staging-p1",
      startedBy: "l6-6-cert",
      lastStatus: "STOPPED",
      containers: [{ name: "game-server", exitCode: 0, imageDigest: DIGEST }],
      overrides: {
        containerOverrides: [
          {
            name: "game-server",
            command: ["node", "dist/server/src/tools/awsDeploy.js", "stage-probe", "task-role", "--run-id", RUN, "--runtime-parameter", RUNTIME_ARN, "--environment", "staging", "--generation", "1", "--pool", "p1", "--disposable-writes", `L6CERT#${RUN}`],
            environment: [{ name: "GS_STORAGE", value: CERTIFIER_STORAGE_OVERRIDE }],
          },
        ],
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* LIVE-6 final convergence: the drills' evidence (drills.ts)          */
/* ------------------------------------------------------------------ */

const ADOPTION_CLAIM = "22222222-2222-4222-8222-222222222222";
const RELAYER_OLD = "juno1xc5etfhxjg4qfc9cx25qh3tvxdcf5skjj5epte";
/** The live escrow document's relayer (the fixture's own key): after a rotation, the NEW address. */
const relayerNew = (): string => junoConfig().relayer.address;
/** L6-2's flip record for a p2 -> p1 flip (the drill's), settled, its window published then closed by the recovery. */
const FLIP_WINDOW = { opened_at: Date.parse("2026-09-30T09:00:00Z"), expires_at: Date.parse("2026-09-30T09:45:00Z"), closed_at: Date.parse("2026-09-30T09:20:00Z") };
function flipRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  const snap = (at: number, epochs: [number, number], primary: string) => ({ at, pools: { p1: { epoch: epochs[0], task: `t-p1-${epochs[0]}` }, p2: { epoch: epochs[1], task: `t-p2-${epochs[1]}` } }, identity_writer: { epoch: epochs[0] + epochs[1], pool: primary, task: `t-${primary}` }, relayer: { epoch: 3, pool: primary, task: `t-${primary}` } });
  return {
    format: "18COSMOS/FLIP-EVIDENCE/v1",
    environment: "staging",
    from: "p2",
    to: "p1",
    expected_version: 4,
    note: "l6-6 flip drill",
    verdict: "roles-settled",
    preflight: { at: FLIP_WINDOW.opened_at - 60_000, checks: [] },
    before: snap(FLIP_WINDOW.opened_at - 1000, [4, 7], "p2"),
    cas: { at: FLIP_WINDOW.opened_at + 1000, run: "op:r-0123abcd", outcome: "applied", version: 5, detail: "" },
    window: { ...FLIP_WINDOW, suppression: "closed" },
    observations: [],
    after: snap(FLIP_WINDOW.opened_at + 120_000, [5, 8], "p1"),
    ...over,
  };
}

/** Writes a drill's machine records into the package: `restore` (the generation gate, the plan's adoption, the restore
 *  alarms), `flip` (L6-2's record, the per-pool captures, the flip alarms), `rotation` (the rotation gate's record). */
function writeDrillEvidence(dir: string, drill: "restore" | "flip" | "rotation", over: Record<string, unknown> = {}): void {
  const adoption = ADOPTED.adoption as NonNullable<AppGenerationFacts["adoption"]>;
  if (drill === "restore") {
    write(dir, "gate-generation.json", {
      format: "18COSMOS/GENERATION-GATE/v1",
      environment: "staging",
      from_generation: 1,
      verdict: "OPEN",
      attestation: { generation: 2, game_table: "gs-staging-game-g2", restore_id: adoption.restore_id },
      adoption_claim: adoption.claim,
      checks: [{ name: "APPGEN at the new generation", status: "pass", detail: "current_generation 2" }],
      gated_at: "2026-09-30T09:50:00.000Z",
      ...over,
    });
    const planFile = path.join(dir, "terraform/app/plan.json");
    const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
    plan.variables = { ...(plan.variables ?? {}), generation_adoption: { value: { generation: 2, game_table: "gs-staging-game-g2", restore_id: adoption.restore_id } } };
    write(dir, "terraform/app/plan.json", plan);
    const win = { from: "p1", to: "p2", opened_at: Date.parse("2026-09-30T09:40:00Z"), expires_at: Date.parse("2026-09-30T10:25:00Z") };
    const obs = (alarm: string, injected: string, overlap: boolean) => ({ alarm, injected_at: Date.parse(injected), alarm_at: Date.parse(injected) + 70_000, state: "ALARM", actions_suppressed: false, overlapping_flip_window: overlap ? win : null });
    write(dir, "probe-restore-alarms.json", {
      format: "18COSMOS/L6-6-RESTORE-ALARM-DRILL/v1",
      run_id: RUN,
      cases: {
        "r1-generation-lost": obs("gs-staging-r1-generation-lost", "2026-09-30T09:41:00Z", true),
        "a4g-generation-refused": obs("gs-staging-a4g-generation-refused", "2026-09-30T09:46:00Z", false),
        "a4i-identity-restore-refused": obs("gs-staging-a4i-identity-restore-refused", "2026-09-30T09:47:00Z", false),
        "r2-money-journal-ahead": obs("gs-staging-r2-money-journal-ahead", "2026-09-30T09:48:00Z", false),
        "r3-restore-unverified": obs("gs-staging-p1-r3-restore-unverified", "2026-09-30T08:30:00Z", false),
      },
      ...over,
    });
  } else if (drill === "flip") {
    write(dir, "flip-record.json", flipRecord(over));
  } else {
    const gated = "2026-09-30T08:50:00.000Z"; // before the running task was created (09:00): the pools restarted after it
    write(dir, "gate-relayer-rotation.json", {
      format: "18COSMOS/RELAYER-ROTATION-GATE/v1",
      environment: "staging",
      from_relayer: RELAYER_OLD,
      to_relayer: relayerNew(),
      configured_relayer: RELAYER_OLD,
      pools: ["p1"],
      evidence_captured_at: "2026-09-30T08:45:00Z",
      queue: "empty",
      verdict: "OPEN",
      checks: [
        { name: "the active configuration names the OLD relayer", status: "pass", detail: `relayer ${RELAYER_OLD}` },
        { name: "drained p1", status: "pass", detail: "desired 0, running 0, pending 0" },
        { name: `RELAYQ#${RELAYER_OLD} empty (strongly consistent, every page)`, status: "pass", detail: "no entry" },
        { name: `RELAYQ#${relayerNew()}`, status: "skipped", detail: "the new address's queue is never consulted" },
      ],
      gated_at: gated,
      ...over,
    });
  }
}

interface Built {
  readonly dir: string;
  readonly ctx: (overrides?: Partial<CertContext>) => Promise<CertContext>;
}

/** A complete, passing package; `skip` leaves files out, `mutate` edits one before it is written. */
async function buildPackage(options: { readonly part?: "app" | "all"; readonly skip?: readonly string[]; readonly mutate?: Record<string, (value: any) => any>; readonly taskRole?: unknown; readonly edge?: unknown; readonly generation?: ReaderScript } = {}): Promise<Built> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-l66-"));
  const files: Record<string, unknown> = {
    [EVIDENCE_FILES.services]: SERVICES,
    [EVIDENCE_FILES.taskDefinition("p1")]: TASK_DEFINITION,
    [EVIDENCE_FILES.targetGroups]: TARGET_GROUPS,
    [EVIDENCE_FILES.loadBalancerAttributes]: { Attributes: [{ Key: "idle_timeout.timeout_seconds", Value: "300" }] },
    [EVIDENCE_FILES.distributionConfig]: DISTRIBUTION,
    [EVIDENCE_FILES.originRequestPolicy]: ORIGIN_REQUEST_POLICY,
    [EVIDENCE_FILES.securityGroups]: SECURITY_GROUPS,
    [EVIDENCE_FILES.listenerRules]: LISTENER_RULES,
    /* LIVE-6 final convergence: L6-2's per-pool captures and L6-5B's alarms, as the converged capture-evidence writes them. */
    [POOL_EVIDENCE_FILES.manifest]: { format: "18COSMOS/EVIDENCE/v1", captured_at: "2026-09-30T10:29:00Z", environment: "staging", region: "us-east-1", pools: ["p1"] },
    [POOL_EVIDENCE_FILES.targetHealth("p1")]: { TargetHealthDescriptions: [{ Target: { Id: TASK_IP, Port: 8917 }, TargetHealth: { State: "healthy" } }] },
    [path.join(POOL_EVIDENCE_FILES.revisionsDir("p1"), "7.json")]: { ...TASK_DEFINITION, tags: [{ key: "gs:identity-layout", value: "2" }] },
    [EVIDENCE_FILES.alarms]: ALARMS,
    [EVIDENCE.runningTasks]: RUNNING_TASKS,
    [EVIDENCE.clusterTasks]: CLUSTER_TASKS,
    [EVIDENCE.targetHealth]: { TargetHealthDescriptions: [{ Target: { Id: TASK_IP, Port: 8917 }, TargetHealth: { State: "healthy" } }] },
    [EVIDENCE.distribution]: { Distribution: { Id: "E123", DomainName: "d111111abcdef8.cloudfront.net", DistributionConfig: DISTRIBUTION.DistributionConfig } },
    [EVIDENCE.capture]: { format: "18COSMOS/L5-8-CAPTURE/v1", captured_at: TIMES.capture },
    [EVIDENCE.taskRoleRun]: CERTIFIER_RUN,
    [EVIDENCE.taskRole]: options.taskRole ?? (await taskRoleRecord()),
    [EVIDENCE.edge]: options.edge ?? (await edgeRecord()),
    [EVIDENCE.verifyLedger]: LEDGER_RECORD,
    [revisionsFile("p1")]: { taskDefinitions: [TASK_DEFINITION.taskDefinition] },
    "terraform/ledger/version.json": TERRAFORM_VERSION,
    "terraform/ledger/plan.json": ledgerPlan(),
    "terraform/ledger/plan-exitcode.txt": "2\n",
    "terraform/ledger/lock.hcl": lockText("ledger"),
    "terraform/ledger/run.json": { run_id: RUN, captured_at: "2026-09-30T10:20:00Z" },
    "terraform/app/run.json": { run_id: RUN, captured_at: "2026-09-30T10:21:00Z" },
    "terraform/app/version.json": TERRAFORM_VERSION,
    "terraform/app/plan.json": appPlan(),
    "terraform/app/plan-exitcode.txt": "2\n",
    "terraform/app/lock.hcl": lockText("app"),
  };
  files[EVIDENCE.taskRoleLog] = { events: recordLines(files[EVIDENCE.taskRole]).map((message, i) => ({ timestamp: i, message })) };
  for (const [file, value] of Object.entries(files)) {
    if (options.skip?.includes(file)) continue;
    const mutate = options.mutate?.[file];
    write(dir, file, mutate === undefined ? value : mutate(clone(value)));
  }
  const part = options.part ?? "app";
  const startup = await startupOf();
  const verification = (): { checks: Check[]; startup: typeof startup } => ({
    checks: [
      { name: "runtime document p1", status: "pass", detail: "v3" },
      ...checkEvidenceDirectory(dir, { environment: "staging", pools: ["p1"], primaryPool: "p1", port: 8917, runtimeParameterArns: new Map([["p1", RUNTIME_ARN]]), routes: { p1: "/gs/p/p1" } }),
      ...(part === "app" ? [{ name: "ledger table: PITR and TTL", status: "skipped" as const, detail: "not readable across accounts" }] : []),
    ],
    startup,
  });
  const expect = { run: RUN, environment: "staging", generation: 1, primaryPool: "p1", pools: ["p1"], part } as const;
  if (!options.skip?.includes(EVIDENCE.prerequisite)) {
    const first = prerequisiteChecks(dir, verification(), expect);
    const record = prerequisiteRecord(RUN, Date.parse(TIMES.prerequisite), expect, first);
    const mutate = options.mutate?.[EVIDENCE.prerequisite];
    write(dir, EVIDENCE.prerequisite, stableStringify(mutate === undefined ? record : mutate(clone(record))));
  }
  return {
    dir,
    ctx: async (overrides = {}) => ({
      dir,
      run: RUN,
      scenario: "read-only",
      replacedPools: [],
      environment: "staging",
      generation: 1,
      primaryPool: "p1",
      pools: ["p1"],
      commit: HEAD,
      repository: REPO,
      prerequisite: prerequisiteChecks(dir, verification(), expect),
      generationEvidence: await generationOf(options.generation ?? {}),
      heartbeats: null,
      ...overrides,
    }),
  };
}

const cleanup = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });

async function verdictOf(built: Built, overrides: Partial<CertContext> = {}) {
  const ctx = await built.ctx(overrides);
  return { ctx, result: certify(ctx) };
}

const failedGates = (result: ReturnType<typeof certify>) => result.gates.filter((g) => g.status === "fail").map((g) => g.id);
const gateFailures = (result: ReturnType<typeof certify>, id: string) => failures(result.gates.find((g) => g.id === id)?.checks ?? []).map((c) => `${c.name}: ${c.detail}`);

/* ------------------------------------------------------------------ */
/* §1 Every gate counts                                                 */
/* ------------------------------------------------------------------ */

describe("L6-6 §1: every required gate contributes to the verdict", () => {
  test("a complete, good package is PASS; every gate passed; the report's first line is the verdict", async () => {
    const built = await buildPackage();
    try {
      const { ctx, result } = await verdictOf(built);
      assert.deepEqual(failedGates(result), [], JSON.stringify(result.gates.map((g) => [g.id, failures(g.checks)]), null, 2));
      assert.equal(result.passed, true);
      assert.deepEqual(
        result.gates.map((g) => [g.id, g.status]),
        [
          ["prerequisite", "pass"],
          ["drain", "not-required"],
          ["iam", "pass"],
          ["transactions", "pass"],
          ["proxy-hops", "pass"],
          ["query-strings", "pass"],
          ["websocket", "pass"],
          ["kms", "pass"],
          ["terraform", "pass"],
          ["generation", "pass"],
          ["identity", "pass"],
          ["review", "pass"],
          ["rollback", "pass"],
          ["restore-quiet", "not-required"],
          ["restore-fence", "not-required"],
          /* LIVE-6 final convergence: L6-5B's alarms on every scenario; the drills' gates only on theirs. */
          ["alarms", "pass"],
          ["generation-gate", "not-required"],
          ["restore-alarms", "not-required"],
          ["flip", "not-required"],
          ["flip-alarms", "not-required"],
          ["relayer-rotation", "not-required"],
          ["evidence", "pass"],
        ],
      );
      const text = certificationText(ctx, result);
      assert.equal(text.split("\n")[0], "LIVE-6 AWS STAGING CERTIFICATION: PASS");
      assert.match(text, /drain.*NOT REQUIRED -- not required: a read-only certification replaces no task.*stop-first 0\/100 alone never proves it/);
    } finally {
      cleanup(built.dir);
    }
  });

  test("breaking any one gate's evidence FAILS exactly that gate, and the certification", async () => {
    const cases: Array<[string, Parameters<typeof buildPackage>[0], string]> = [
      ["prerequisite", { mutate: { [EVIDENCE.targetHealth]: (v) => ((v.TargetHealthDescriptions[0].TargetHealth.State = "unhealthy"), v) } }, "prerequisite"],
      ["iam", { taskRole: await taskRoleRecord({ iam: { status: "ran", ...(await runIamProbe({ game: iamDynamo({ enforce: false }).client, ledger: iamDynamo({ enforce: true }).client }, { run: RUN, gameTable: "g", ledgerTable: "arn:l", nonce: "n" })) } }) }, "iam"],
      ["transactions", { taskRole: await taskRoleRecord({ transactions: { status: "ran", partition: `L6CERT#${RUN}`, results: { ...TRANSACTIONS, cleanup: { deleted: 4, remaining: 1, left: ["T3"], errors: [] } } } }) }, "transactions"],
      ["proxy-hops", { edge: await edgeRecord(fakeEdge({ appended: 1 })) }, "proxy-hops"],
      ["query-strings", { edge: await edgeRecord(fakeEdge({ allowList: ["cp", "cr", "cb"] })) }, "query-strings"],
      ["websocket", { edge: await edgeRecord(fakeEdge({ idle: () => ({ upgrade_status: null, opened: true, events: [...pingsUntil(300_000), { at_ms: 300_000, kind: "close", code: 1006, clean: false }], ended_by: "remote", duration_ms: 300_000 }) })) }, "websocket"],
      ["kms", { taskRole: await taskRoleRecord({ kms: { status: "not-run", reason: "escrow is null (no KMS keys)" } }) }, "kms"],
      ["terraform", { mutate: { "terraform/ledger/plan.json": (v) => ((v.resource_changes[0].change.actions = ["delete", "create"]), v) } }, "terraform"],
      ["evidence", { mutate: { [EVIDENCE.clusterTasks]: (v) => ({ ...v, note: "AKIAABCDEFGHIJKLMNOP" }) } }, "evidence"],
    ];
    for (const [label, options, gate] of cases) {
      const built = await buildPackage(options);
      try {
        const { result } = await verdictOf(built);
        assert.equal(result.passed, false, label);
        assert.ok(failedGates(result).includes(gate), `${label}: failed gates ${JSON.stringify(failedGates(result))}`);
        const text = certificationText(await built.ctx(), result);
        assert.equal(text.split("\n")[0], VERDICT_LINE(false));
        assert.match(text.split("\n")[1], new RegExp(`failed gates: .*${gate}`));
      } finally {
        cleanup(built.dir);
      }
    }
  });

  test("a later branch adds a gate without redesign: an extra gate is evaluated and counted", async () => {
    const built = await buildPackage();
    try {
      const ctx = await built.ctx();
      const extra = { id: "l6-1-routing", title: "later", required: () => true, evaluate: () => ({ checks: [{ name: "x", status: "fail" as const, detail: "not yet" }] }) };
      const result = certify(ctx, [extra]);
      assert.deepEqual(failedGates(result), ["l6-1-routing"]);
      assert.equal(result.passed, false);
      const empty = certify(ctx, [{ ...extra, evaluate: () => ({ checks: [] }) }]);
      assert.deepEqual(failedGates(empty), ["l6-1-routing"], "a gate with no check is not a pass");
    } finally {
      cleanup(built.dir);
    }
  });

  test("the replacement scenario REQUIRES the drain gate: without drain evidence it FAILS", async () => {
    const built = await buildPackage();
    try {
      const { result } = await verdictOf(built, { scenario: "replacement", replacedPools: ["p1"] });
      assert.ok(failedGates(result).includes("drain"));
      assert.match(gateFailures(result, "drain").join("\n"), /drain-p1\/tasks-before.json is missing/);
      const none = await verdictOf(built, { scenario: "replacement", replacedPools: [] });
      assert.ok(failedGates(none.result).includes("drain"), "a replacement naming no pool");
    } finally {
      cleanup(built.dir);
    }
  });
});

/* ------------------------------------------------------------------ */
/* §2 Missing or skipped evidence is FAIL                               */
/* ------------------------------------------------------------------ */

describe("L6-6 §2: omitted or skipped required evidence is FAIL, never PASS", () => {
  test("each missing file fails its gate", async () => {
    const cases: Array<[string, string]> = [
      [EVIDENCE.taskRole, "iam"],
      [EVIDENCE.taskRole, "kms"],
      [EVIDENCE.taskRole, "transactions"],
      [EVIDENCE.taskRoleRun, "iam"],
      [EVIDENCE.edge, "proxy-hops"],
      [EVIDENCE.edge, "query-strings"],
      [EVIDENCE.edge, "websocket"],
      [EVIDENCE.prerequisite, "prerequisite"],
      [EVIDENCE.capture, "prerequisite"],
      [EVIDENCE.runningTasks, "prerequisite"],
      [EVIDENCE.clusterTasks, "prerequisite"],
      [EVIDENCE.targetHealth, "prerequisite"],
      [EVIDENCE.verifyLedger, "prerequisite"],
      ["terraform/app/plan.json", "terraform"],
      ["terraform/ledger/lock.hcl", "terraform"],
      ["terraform/app/plan-exitcode.txt", "terraform"],
    ];
    for (const [file, gate] of cases) {
      const built = await buildPackage({ skip: [file] });
      try {
        const { result } = await verdictOf(built);
        assert.equal(result.passed, false, file);
        assert.ok(failedGates(result).includes(gate), `${file} -> ${gate}: ${JSON.stringify(failedGates(result))}`);
      } finally {
        cleanup(built.dir);
      }
    }
  });

  test("a probe section not run is FAIL: transactions without --disposable-writes, KMS without escrow, the sockets without a session", async () => {
    const tx = await buildPackage({ taskRole: await taskRoleRecord({ transactions: { status: "not-run", reason: `--disposable-writes L6CERT#${RUN} was not given` } }) });
    const ws = await buildPackage({ edge: await edgeRecord(fakeEdge(), { cookie: null }) });
    const iam = await buildPackage({ taskRole: await taskRoleRecord({ iam: { status: "ran", results: [] } }) });
    try {
      assert.match(gateFailures((await verdictOf(tx)).result, "transactions").join("\n"), /not run.*required/);
      assert.match(gateFailures((await verdictOf(ws)).result, "websocket").join("\n"), /not run.*GS_CERT_SESSION_COOKIE/);
      assert.match(gateFailures((await verdictOf(iam)).result, "iam").join("\n"), /missing .*a skipped probe is a failure/);
    } finally {
      for (const b of [tx, ws, iam]) cleanup(b.dir);
    }
  });

  test("a SKIP from the verifier is a failure (only the ledger half is replaced, and only by a PASS record); --part all needs no record", async () => {
    const built = await buildPackage({ mutate: { [EVIDENCE.verifyLedger]: (v) => ({ ...v, verdict: "FAIL" }) } });
    const all = await buildPackage({ part: "all", skip: [EVIDENCE.verifyLedger] });
    try {
      assert.ok(failedGates((await verdictOf(built)).result).includes("prerequisite"));
      assert.deepEqual(failedGates((await verdictOf(all)).result), []);
      const startup = await startupOf();
      const skipped = prerequisiteChecks(all.dir, { checks: [{ name: "control-plane evidence", status: "skipped", detail: "--no-evidence" }], startup }, { run: RUN, environment: "staging", generation: 1, primaryPool: "p1", pools: ["p1"], part: "all" });
      assert.match(failures(skipped.checks).map((c) => c.detail).join("\n"), /a skip is not evidence/);
      const noEscrow = prerequisiteChecks(all.dir, { checks: [{ name: "KMS signing keys", status: "skipped", detail: "escrow is null" }], startup }, { run: RUN, environment: "staging", generation: 1, primaryPool: "p1", pools: ["p1"], part: "all" });
      assert.match(failures(noEscrow.checks).map((c) => c.detail).join("\n"), /escrow is null: the staging certification needs/);
    } finally {
      cleanup(built.dir);
      cleanup(all.dir);
    }
  });

  test("evidence from another run, another deployment or before the prerequisite is never counted", async () => {
    const other = await taskRoleRecord();
    const built = await buildPackage({ taskRole: { ...other, run_id: "l6cert-another" } });
    const early = await buildPackage({ edge: { ...(await edgeRecord()), started_at: "2026-09-30T09:00:00.000Z" } });
    const gen = await buildPackage({ taskRole: { ...other, generation: 2 } });
    const stale = await buildPackage({ mutate: { [EVIDENCE.capture]: (v) => ({ ...v, captured_at: "2026-09-30T10:01:00Z" }) } });
    try {
      assert.match(gateFailures((await verdictOf(built)).result, "kms").join("\n"), /this run.*another run is never counted/);
      assert.match(gateFailures((await verdictOf(early)).result, "websocket").join("\n"), /not after the prerequisite/);
      assert.match(gateFailures((await verdictOf(gen)).result, "iam").join("\n"), /this deployment/);
      assert.match(gateFailures((await verdictOf(stale)).result, "prerequisite").join("\n"), /before the last probe finished/);
    } finally {
      for (const b of [built, early, gen, stale]) cleanup(b.dir);
    }
  });
});

/* ------------------------------------------------------------------ */
/* §3 Terraform                                                         */
/* ------------------------------------------------------------------ */

describe("L6-6 §3: a destructive plan FAILS the certification", () => {
  const judgeApp = (plan: unknown, extra: { exit?: string; lock?: string; version?: unknown } = {}) =>
    judgeTerraformStack("app", { version: extra.version ?? TERRAFORM_VERSION, plan, exitCode: extra.exit ?? "2", lock: extra.lock ?? lockText("app") }, lockText("app"), { primaryPool: "p1" }).checks;
  const failing = (checks: readonly Check[], name: RegExp) => assert.ok(failures(checks).some((c) => name.test(c.name)), JSON.stringify(failures(checks)));

  test("a good plan passes; a skip_destroy task-definition revision is the one allowed replacement", () => {
    assert.deepEqual(failures(judgeApp(appPlan())), []);
    assert.deepEqual(failures(judgeTerraformStack("ledger", { version: TERRAFORM_VERSION, plan: ledgerPlan(), exitCode: "0\n", lock: lockText("ledger") }, lockText("ledger"), { primaryPool: "p1" }).checks), []);
  });

  test("deleting, replacing or forgetting anything else FAILS by address, protected resources named as such", () => {
    const destructive: Array<[unknown, RegExp]> = [
      [{ address: "module.app.aws_dynamodb_table.game", mode: "managed", type: "aws_dynamodb_table", change: { actions: ["delete", "create"], before: {}, after: {} }, action_reason: "replace_because_cannot_update" }, /PROTECTED module\.app\.aws_dynamodb_table\.game \[delete,create\] \(replace_because_cannot_update\)/],
      [{ address: "module.app.aws_ssm_parameter.runtime[\"p1\"]", mode: "managed", type: "aws_ssm_parameter", change: { actions: ["delete"], before: {}, after: null } }, /PROTECTED .*aws_ssm_parameter/],
      [{ address: "module.app.aws_iam_role.task", mode: "managed", type: "aws_iam_role", change: { actions: ["create", "delete"], before: {}, after: {} } }, /PROTECTED .*aws_iam_role\.task/],
      [{ address: "module.app.aws_vpc_endpoint.gateway[\"dynamodb\"]", mode: "managed", type: "aws_vpc_endpoint", change: { actions: ["delete"], before: {}, after: null } }, /aws_vpc_endpoint/],
      [{ address: "module.app.aws_lb_target_group.primary", mode: "managed", type: "aws_lb_target_group", change: { actions: ["forget"], before: {}, after: null } }, /PROTECTED .*\[forget\]/],
    ];
    for (const [change, detail] of destructive) {
      const checks = judgeApp(appPlan({ extra: [change] }));
      failing(checks, /nothing destroyed or replaced/);
      assert.match(failures(checks).map((c) => c.detail).join("\n"), detail);
    }
    const noSkip = appPlan();
    (noSkip.resource_changes[1] as any).change.after.skip_destroy = false;
    (noSkip.resource_changes[1] as any).change.before.skip_destroy = false;
    failing(judgeApp(noSkip), /nothing destroyed or replaced/);
  });

  test("the versions, the lock, the exit status and the plan's own identity are checked", () => {
    failing(judgeApp(appPlan(), { exit: "1" }), /plan exit status/);
    failing(judgeApp(appPlan(), { exit: "" }), /plan exit status/);
    failing(judgeApp(appPlan(), { lock: edited(lockText("app"), /"h1:5t1[^"]*",\n/, "") }), /provider lock/);
    failing(judgeApp(appPlan(), { lock: edited(lockText("app"), 'version     = "6.66.0"', 'version     = "6.70.0"') }), /provider lock/);
    /* LIVE-6 W1: line endings are not the lock's content -- a lock captured in a CRLF checkout judges the same against a
       LF repository lock, and the other way round (plan-evidence copies the stack's file as the checkout has it). */
    const crlf = (text: string) => text.replace(/\n/g, "\r\n");
    assert.deepEqual(failures(judgeApp(appPlan(), { lock: crlf(lockText("app")) })), []);
    assert.deepEqual(failures(judgeTerraformStack("app", { version: TERRAFORM_VERSION, plan: appPlan(), exitCode: "2\r\n", lock: lockText("app") }, crlf(lockText("app")), { primaryPool: "p1" }).checks), []);
    failing(judgeApp(appPlan(), { lock: crlf(edited(lockText("app"), /"h1:5t1[^"]*",\n/, "")) }), /provider lock/);
    failing(judgeApp(appPlan(), { version: { terraform_version: "1.8.5", provider_selections: { [AWS_PROVIDER]: "6.66.0" } } }), /Terraform version/);
    failing(judgeApp(appPlan(), { version: { terraform_version: "1.16.4", provider_selections: {} } }), /provider selected/);
    failing(judgeApp({}), /the plan is this stack's/);
    failing(judgeApp({ ...appPlan(), errored: true }), /the plan is this stack's/);
    failing(judgeTerraformStack("ledger", { version: TERRAFORM_VERSION, plan: appPlan(), exitCode: "2", lock: lockText("ledger") }, lockText("ledger"), { primaryPool: "p1" }).checks, /the plan is this stack's/);
  });

  test("services are created only when gated on a routing read at plan time that names the primary; stop-first", () => {
    failing(judgeApp(appPlan({ start: false })), /services gated/);
    failing(judgeApp(appPlan({ deferred: true })), /services gated/);
    failing(judgeApp(appPlan({ routing: { fmt: { N: "1" }, primary_pool: { S: "p2" } } })), /services gated/);
    failing(judgeApp(appPlan({ routing: { fmt: { N: "2" }, primary_pool: { S: "p1" } } })), /services gated/);
    const rolling = appPlan();
    rolling.resource_changes[2] = service(["create"], { deployment_minimum_healthy_percent: 100, deployment_maximum_percent: 200 }) as any;
    failing(judgeApp(rolling), /planned services stop-first/);
    const gatedOff = appPlan({ start: false });
    gatedOff.resource_changes.splice(2, 1);
    assert.deepEqual(failures(judgeApp(gatedOff)), [], "start_services = false with no service is the designed first plan");
  });
});

/* ------------------------------------------------------------------ */
/* §4 The prerequisite                                                  */
/* ------------------------------------------------------------------ */

describe("L6-6 §4: the deployment must be settled and known", () => {
  const cases: Array<[string, Record<string, (v: any) => any>, RegExp]> = [
    ["a task on another revision", { [EVIDENCE.runningTasks]: (v) => ((v.tasks[0].taskDefinitionArn = TD.replace(":7", ":6")), v) }, /the examined revision is the one running/],
    ["the evidence is the family's latest, not the running revision", { [EVIDENCE_FILES.taskDefinition("p1")]: (v) => ((v.taskDefinition.taskDefinitionArn = TD.replace(":7", ":8")), v) }, /the running revision/],
    ["a deployment in progress on the same revision", { [EVIDENCE_FILES.services]: (v) => ((v.services[0].deployments[0].rolloutState = "IN_PROGRESS"), v) }, /settled/],
    ["two deployments", { [EVIDENCE_FILES.services]: (v) => (v.services[0].deployments.push({ status: "ACTIVE", taskDefinition: TD, rolloutState: "COMPLETED" }), v) }, /settled/],
    ["a pending task", { [EVIDENCE_FILES.services]: (v) => ((v.services[0].pendingCount = 1), v) }, /settled/],
    ["no running task", { [EVIDENCE.runningTasks]: (v) => ((v.tasks = []), v) }, /the examined revision/],
    ["a run-task beside the service", { [EVIDENCE.clusterTasks]: () => clusterListing([...RUNNING_TASKS.tasks, { ...RUNNING_TASKS.tasks[0], taskArn: `${TASK.slice(0, -1)}5`, group: "family:gs-staging-p1" }]) }, /no task beside the services/],
    ["another target in the target group", { [EVIDENCE.targetHealth]: (v) => ((v.TargetHealthDescriptions[0].Target.Id = "10.0.9.9"), v) }, /target health/],
    ["no BUILD_ID", { [EVIDENCE_FILES.taskDefinition("p1")]: (v) => ((v.taskDefinition.containerDefinitions[0].environment = v.taskDefinition.containerDefinitions[0].environment.filter((e: any) => e.name !== "BUILD_ID")), v) }, /build identity/],
  ];
  for (const [label, mutate, name] of cases) {
    test(`${label} FAILS the prerequisite`, async () => {
      const built = await buildPackage({ mutate });
      try {
        const { result } = await verdictOf(built);
        assert.ok(failedGates(result).includes("prerequisite"));
        assert.ok(failures(result.gates[0].checks).some((c) => name.test(c.name)), JSON.stringify(failures(result.gates[0].checks)));
      } finally {
        cleanup(built.dir);
      }
    });
  }

  test("a deployment that moved after `stage-cert prerequisite` FAILS (the probes ran against something else)", async () => {
    const built = await buildPackage({ mutate: { [EVIDENCE.prerequisite]: (v) => ((v.identity.running_tasks.p1 = ["arn:aws:ecs:us-east-1:111111111111:task/gs-staging/old"]), v) } });
    const failed = await buildPackage({ mutate: { [EVIDENCE.prerequisite]: (v) => ({ ...v, verdict: "FAIL" }) } });
    try {
      assert.match(gateFailures((await verdictOf(built)).result, "prerequisite").join("\n"), /unchanged since the probes began: the deployment moved/);
      assert.match(gateFailures((await verdictOf(failed)).result, "prerequisite").join("\n"), /recorded before the probes/);
    } finally {
      cleanup(built.dir);
      cleanup(failed.dir);
    }
  });

  test("the certifier task must be the primary's running definition, the probe command, the server refused, exit 0", () => {
    const expect = { run: RUN, taskDefinition: TD };
    assert.deepEqual(failures(judgeCertifierTask(CERTIFIER_RUN, expect)), []);
    const mutate = (f: (t: any) => void) => {
      const doc = clone(CERTIFIER_RUN) as any;
      f(doc.tasks[0]);
      return failures(judgeCertifierTask(doc, expect)).map((c) => c.name).join(",");
    };
    assert.match(mutate((t) => (t.taskDefinitionArn = TD.replace(":7", ":6"))), /running task definition/);
    assert.match(mutate((t) => (t.overrides.containerOverrides[0].command = ["node", "dist/server/src/start.js"])), /never the server/);
    assert.match(mutate((t) => (t.overrides.containerOverrides[0].environment = [])), /never the server/);
    assert.match(mutate((t) => (t.group = "service:gs-staging-p1")), /never the server/);
    assert.match(mutate((t) => (t.containers[0].exitCode = 1)), /finished cleanly/);
  });
});

/* ------------------------------------------------------------------ */
/* §5 The edge                                                          */
/* ------------------------------------------------------------------ */

describe("L6-6 §5: the deployed edge -- ALL query strings, two proxies, the distribution's own name", () => {
  const judged = async (transport: EdgeTransport, expectedClientIp: string | null = VIEWER_IP) => judgeQueryProbe((await edgeRecord(transport, { expectedClientIp })).sections, { run: RUN, hopsFromTaskDefinition: "2" });

  test("the contract passes: every parameter unchanged, cp/cr/cb read as sent, two appended entries, the viewer's key", async () => {
    assert.deepEqual(failures(await judged(fakeEdge())), []);
    assert.deepEqual(failures(await judged(fakeEdge(), null)), [], "without --expected-client-ip the hop count is the proof");
  });

  test("an allow-list of exactly cp, cr, cb is REJECTED by name -- live, and in the static evidence", async () => {
    const checks = await judged(fakeEdge({ allowList: ["cp", "cr", "cb"] }));
    assert.match(failures(checks).map((c) => `${c.name}: ${c.detail}`).join("\n"), /ALL query strings forwarded unchanged \(not an allow-list\): only cp, cr and cb arrived: the edge forwards an allow-list/);
    const policy = clone(ORIGIN_REQUEST_POLICY) as any;
    policy.OriginRequestPolicy.OriginRequestPolicyConfig.QueryStringsConfig = { QueryStringBehavior: "whitelist", QueryStrings: { Quantity: 3, Items: ["cp", "cr", "cb"] } };
    assert.ok(failures(checkEdgeEvidence(DISTRIBUTION, policy)).some((c) => /ALL query strings/.test(c.name)));
    const dropped = await judged(fakeEdge({ allowList: ["cp", "cr", "cb", "l6x", "utm_source", "l6enc"] }));
    assert.match(failures(dropped).map((c) => c.detail).join("\n"), /not the 8 sent/, "a single dropped parameter (the repeated one) fails too");
  });

  test("a wrong hop count, a spoofed key, the wrong viewer, the diagnostic missing -- each FAILS", async () => {
    assert.match(failures(await judged(fakeEdge({ appended: 1 }))).map((c) => c.detail).join("\n"), /1 appended, not 2/, "the ALB probed directly (one proxy)");
    assert.match(failures(await judged(fakeEdge({ appended: 3 }))).map((c) => c.detail).join("\n"), /3 appended, not 2/);
    const spoofed = failures(await judged(fakeEdge({ appended: 0 }))).map((c) => c.detail).join("\n");
    assert.match(spoofed, /counted a SPOOFED entry|appended, not 2/);
    assert.match(failures(await judged(fakeEdge(), "198.51.100.200")).map((c) => c.detail).join("\n"), /not the operator's/);
    assert.match(failures(await judged(fakeEdge({ hops: 1 }))).map((c) => c.detail).join("\n"), /configured for 1/);
    assert.match(failures(await judged(fakeEdge({ diagnosticMissing: true }))).map((c) => c.detail).join("\n"), /GS_EDGE_DIAGNOSTIC=staging/);
    const wrongTd = judgeQueryProbe((await edgeRecord()).sections, { run: RUN, hopsFromTaskDefinition: "1" });
    assert.ok(failures(wrongTd).some((c) => /GS_TRUSTED_PROXY_HOPS in the running task definition/.test(c.name)));
  });

  test("the probe must go through the distribution's name (never the ALB's)", async () => {
    const record = await edgeRecord();
    (record.sections as any).target.host = "gs-origin.example.com";
    const built = await buildPackage({ edge: record });
    try {
      assert.match(gateFailures((await verdictOf(built)).result, "query-strings").join("\n"), /probed through the distribution/);
    } finally {
      cleanup(built.dir);
    }
  });

  test("through a REAL loopback chain: the diagnostic behind two appending proxies, the Node transport", async () => {
    const app = http.createServer((req, res) => {
      if (!handleEdgeDiagnostic(req, res, { trustedProxyHops: 2 })) res.end("1830 game server\n");
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const appended = (address: string, target: number) =>
      http.createServer((req, res) => {
        const xff = req.headers["x-forwarded-for"];
        const headers = { ...req.headers, "x-forwarded-for": `${typeof xff === "string" && xff !== "" ? `${xff}, ` : ""}${address}` };
        const upstream = http.request({ host: "127.0.0.1", port: target, method: req.method, path: req.url, headers }, (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        });
        req.pipe(upstream);
      });
    const alb = appended(CLOUDFRONT_IP, (app.address() as AddressInfo).port);
    await new Promise<void>((resolve) => alb.listen(0, "127.0.0.1", resolve));
    const cloudfront = appended(VIEWER_IP, (alb.address() as AddressInfo).port);
    await new Promise<void>((resolve) => cloudfront.listen(0, "127.0.0.1", resolve));
    try {
      const transport = nodeEdgeTransport();
      const noSockets: EdgeTransport = { get: transport.get, observeSocket: async () => ({ upgrade_status: null, opened: false, events: [], ended_by: "error", duration_ms: 0 }) };
      const sections = await runEdgeProbe(noSockets, { run: RUN, baseUrl: `http://127.0.0.1:${(cloudfront.address() as AddressInfo).port}`, origin: "https://play.example.com", sessionCookie: null, expectedClientIp: VIEWER_IP, albIdleSeconds: 300, originReadTimeoutSeconds: 60, holdMs: 400_000 });
      assert.deepEqual(failures(judgeQueryProbe(sections, { run: RUN, hopsFromTaskDefinition: "2" })), []);
      const answer = (sections as any).query.requests[1].answer;
      assert.equal(answer.format, EDGE_DIAGNOSTIC_FORMAT);
      assert.equal(answer.forwarded_entries, 4, "two spoofed + CloudFront's + the ALB's");
      assert.ok(!JSON.stringify(answer).includes(VIEWER_IP) && !JSON.stringify(answer).includes("utm_source"), "no address or parameter in the clear");
    } finally {
      for (const s of [cloudfront, alb, app]) await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});

/* ------------------------------------------------------------------ */
/* §6 IAM                                                               */
/* ------------------------------------------------------------------ */

describe("L6-6 §6: IAM -- expected denial, unexpected authority, another principal, malformed, infrastructure", () => {
  const ctx = { run: RUN, gameTable: "gs-staging-game-g1", ledgerTable: "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger", nonce: "n0nce" };
  const ROLE = "gs-staging-app-task";

  test("against an IAM-enforcing service, as the task role: every probe as expected", async () => {
    const game = iamDynamo({ enforce: true });
    const ledger = iamDynamo({ enforce: true });
    const { results } = await runIamProbe({ game: game.client, ledger: ledger.client }, ctx);
    assert.deepEqual(results.map((r) => r.id), [...IAM_PROBE_IDS]);
    assert.deepEqual(failures(judgeIamProbe({ status: "ran", results }, ROLE, IAM_PROBE_IDS)), []);
    assert.equal(results.filter((r) => r.expect === "deny").length, 9);
    assert.equal(results.filter((r) => r.expect === "allow").length, 4);
  });

  test("without IAM enforcement (DynamoDB Local's behaviour) every forbidden shape is UNEXPECTED WRITE AUTHORITY -- and nothing was written", async () => {
    const game = iamDynamo({ enforce: false });
    const { results } = await runIamProbe({ game: game.client, ledger: iamDynamo({ enforce: true }).client }, ctx);
    const checks = judgeIamProbe({ status: "ran", results }, ROLE, IAM_PROBE_IDS);
    const bad = failures(checks).map((c) => c.detail);
    assert.equal(bad.length, 5, JSON.stringify(bad));
    assert.ok(bad.every((d) => d.startsWith("unexpected-write-authority")));
  });

  test("the bootstrap role (it MAY put SYSTEM/*) is caught: another principal's denial and a SYSTEM put reaching the condition", async () => {
    const asBootstrap = iamDynamo({ enforce: true, role: "gs-staging-bootstrap", allowSystemPut: true });
    const { results } = await runIamProbe({ game: asBootstrap.client, ledger: iamDynamo({ enforce: true, role: "gs-staging-bootstrap" }).client }, ctx);
    const text = failures(judgeIamProbe({ status: "ran", results }, ROLE, IAM_PROBE_IDS)).map((c) => c.detail).join("\n");
    assert.match(text, /denied-not-the-task-role: the denial names assumed-role\/gs-staging-bootstrap/);
    assert.match(text, /unexpected-write-authority/);
  });

  test("the classification matrix", () => {
    const e = (name: string, extra: Partial<Extract<IamAnswer, { kind: "error" }>> = {}): IamAnswer => ({ kind: "error", name, reasons: [], principal: null, ...extra });
    const role = { kind: "assumed-role" as const, role: ROLE };
    const cases: Array<["deny" | "allow", IamAnswer, number, number, string]> = [
      ["deny", e("AccessDeniedException", { principal: role }), 1, 0, "denied-as-expected"],
      ["deny", e("AccessDeniedException", { principal: { kind: "other" } }), 1, 0, "denied-not-the-task-role"],
      ["deny", e("AccessDeniedException"), 1, 0, "denied-not-the-task-role"],
      ["deny", e("ConditionalCheckFailedException"), 1, 0, "unexpected-write-authority"],
      ["deny", e("TransactionCanceledException", { reasons: ["ConditionalCheckFailed"] }), 1, 0, "unexpected-write-authority"],
      ["deny", { kind: "success" }, 1, 0, "unexpected-write-applied"],
      ["deny", e("ValidationException"), 1, 0, "malformed-probe"],
      ["deny", e("ResourceNotFoundException"), 1, 0, "malformed-probe"],
      ["deny", e("ThrottlingException"), 1, 0, "infrastructure-failure"],
      ["deny", e("ExpiredTokenException"), 1, 0, "infrastructure-failure"],
      ["deny", e("TimeoutError"), 1, 0, "infrastructure-failure"],
      ["deny", e("TransactionCanceledException", { reasons: ["TransactionConflict"] }), 1, 0, "infrastructure-failure"],
      ["allow", e("TransactionCanceledException", { reasons: ["None", "ConditionalCheckFailed"] }), 2, 1, "authorized-as-expected"],
      ["allow", e("TransactionCanceledException", { reasons: ["ConditionalCheckFailed", "ConditionalCheckFailed"] }), 2, 1, "malformed-probe"],
      ["allow", e("TransactionCanceledException", { reasons: ["None", "ValidationError"] }), 2, 1, "malformed-probe"],
      ["allow", e("TransactionCanceledException", { reasons: ["None", "ThrottlingError"] }), 2, 1, "infrastructure-failure"],
      ["allow", e("AccessDeniedException", { principal: role }), 2, 1, "authorized-shape-refused"],
      ["allow", { kind: "success" }, 2, 1, "unexpected-write-applied"],
    ];
    for (const [expect, answer, items, index, outcome] of cases) {
      assert.equal(classifyIamAnswer({ expect, answer, item_count: items, probe_index: index }, ROLE).outcome, outcome, `${expect} ${JSON.stringify(answer)}`);
    }
  });

  test("an impossible success is cleaned up by this run's nonce only", async () => {
    const sent: Sent[] = [];
    const client = {
      async send(command: { constructor: { name: string }; input: Record<string, any> }) {
        sent.push({ name: command.constructor.name, input: command.input });
      },
    };
    const { results } = await runIamProbe({ game: client as never, ledger: client as never }, ctx);
    assert.ok(results.every((r) => r.answer.kind === "success"));
    const deletes = sent.filter((s) => s.name === "DeleteItemCommand");
    assert.ok(deletes.length > 0 && deletes.every((d) => d.input.ConditionExpression === "#l6n = :l6n" && d.input.ExpressionAttributeValues[":l6n"].S === "n0nce"));
    assert.ok(deletes.every((d) => !(d.input.Key.pk.S === "SYSTEM" && d.input.Key.sk.S === "ROUTING")));
  });
});

/* ------------------------------------------------------------------ */
/* §7 Transactions                                                      */
/* ------------------------------------------------------------------ */

describe("L6-6 §7: the transaction probe -- TransactionConflict and the engine's assumptions", () => {
  test("the engine classifies a TransactionConflict (either form) as not-applied / conflict; a mismatch as unknown", () => {
    const cancelled = classifyTransactFailure(Object.assign(new Error("x"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }] }));
    assert.equal(cancelled.kind, "not-applied");
    assert.equal((cancelled as { conflict: boolean }).conflict, true);
    const exception = classifyTransactFailure(Object.assign(new Error("x"), { name: "TransactionConflictException" }));
    assert.equal(exception.kind, "not-applied");
    assert.equal(classifyTransactFailure(Object.assign(new Error("x"), { name: "IdempotentParameterMismatchException" })).kind, "unknown");
    assert.equal(classifyTransactFailure(Object.assign(new Error("x"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] })).kind, "refused");
  });

  test("the passing record passes; no conflict, a broken invariant, an unknown outcome, a leftover, a reused run -- each FAILS", () => {
    assert.deepEqual(failures(judgeTransactionProbe({ status: "ran", results: TRANSACTIONS })), []);
    const variant = (f: (r: any) => void) => {
      const r = clone(TRANSACTIONS) as any;
      f(r);
      return failures(judgeTransactionProbe({ status: "ran", results: r })).map((c) => `${c.name}: ${c.detail}`).join("\n");
    };
    assert.match(variant((r) => ((r.t3.conflicts = 0), (r.t3.conflicts_classified_not_applied = 0))), /no conflict in 20x6 concurrent writes: not established/);
    assert.match(variant((r) => (r.t3.final_n = 72)), /a conflict never applied anything/);
    assert.match(variant((r) => (r.t3.other = { "TimeoutError->unknown": 1 })), /unknown outcomes/);
    assert.match(variant((r) => (r.t2.b = { kind: "applied" })), /exactly one applies/);
    assert.match(variant((r) => (r.t1.b_present = true)), /cancels the whole transaction/);
    assert.match(variant((r) => (r.t4.final_n = 2)), /applied once/);
    assert.match(variant((r) => (r.t4.same_token_resend = { kind: "refused" })), /applied once/);
    assert.match(variant((r) => (r.t4.mismatch = "applied")), /IdempotentParameterMismatch/);
    assert.match(variant((r) => (r.cleanup = { deleted: 3, remaining: 2, left: ["T1-A", "T2"], errors: [] })), /cleanup: remaining 2 \[T1-A, T2\]/);
    assert.match(variant((r) => (r.errors = ["T3: ThrottlingException"])), /every test ran/);
    assert.match(failures(judgeTransactionProbe({ status: "ran", results: { refused: "the partition L6CERT#x already holds 2 item(s)" } })).map((c) => c.detail).join(""), /already holds/);
  });
});

/* ------------------------------------------------------------------ */
/* §8 KMS                                                               */
/* ------------------------------------------------------------------ */

describe("L6-6 §8: KMS latency -- below 3 s passes, at or above fails, an invalid answer fails", () => {
  const run = async (options: Parameters<typeof fakeKms>[0], samples = 3) => {
    const clock = { now: 0 };
    const kms = fakeKms({ ...options, clock });
    const results = await runKmsProbe(junoConfig(), { kms: kms.client, clock: () => clock.now }, { run: RUN, samples });
    return { results, checks: judgeKmsProbe({ status: "ran", results }), calls: kms.calls };
  };

  test("valid signatures well under the bound pass; the signatures verify against the CONFIGURED keys; the record holds no signature", async () => {
    const { checks, results, calls } = await run({ latencyMs: () => 180 });
    assert.deepEqual(failures(checks), []);
    assert.equal(KMS_LATENCY_BOUND_MS, 3_000);
    assert.equal(calls.filter((c) => c.startsWith("Sign")).length, 9);
    const text = JSON.stringify(results);
    assert.ok(!/arn:aws:kms/.test(text), "no key ARN in the record (a fingerprint instead)");
    assert.ok(!/"signature_hex"|"der"/.test(text));
  });

  test("a Sign at 2 999 ms passes; at 3 000 ms or more FAILS", async () => {
    assert.deepEqual(failures((await run({ latencyMs: () => 2_999 })).checks), []);
    const at = (await run({ latencyMs: (arn, i) => (arn === SETTLEMENT_KEY && i === 2 ? 3_000 : 150) })).checks;
    assert.deepEqual(failures(at).map((c) => c.name), ["KMS settlement: Sign latency below 3000 ms"]);
    assert.match(failures((await run({ latencyMs: () => 4_200 })).checks)[0].detail, /max 4200 ms/);
  });

  test("an invalid answer FAILS: another key's signature, garbage DER, a wrong public key", async () => {
    const other = await run({ tamper: (arn, der) => (arn === ADMISSION_KEY ? derOf(signDigest(Buffer.alloc(32, 0x42), Buffer.alloc(32, 1))) : der) });
    assert.ok(failures(other.checks).some((c) => /admission.*Sign verified/.test(c.name)));
    const garbage = await run({ tamper: (arn, der) => (arn === RELAYER_KEY ? Buffer.from("3002deadbeef", "hex") : der) });
    assert.ok(failures(garbage.checks).some((c) => /relayer.*Sign verified/.test(c.name)));
    const clock = { now: 0 };
    const kms = fakeKms({ clock });
    const wrongKey = { ...kms.client, getPublicKey: async (arn: string) => (arn === SETTLEMENT_KEY ? spkiOf(pub(ADMISSION_KEY)) : kms.client.getPublicKey(arn)) };
    const results = await runKmsProbe(junoConfig(), { kms: wrongKey, clock: () => clock.now }, { run: RUN, samples: 1 });
    assert.ok(failures(judgeKmsProbe({ status: "ran", results })).some((c) => /public keys = the configuration's/.test(c.name)));
  });

  test("a missing sample count, a doctored bound or a key that did not open FAILS", () => {
    assert.ok(failures(judgeKmsProbe({ status: "ran", results: { bound_ms: 10_000, samples_per_key: 1, identities: { ok: true }, keys: {} } })).some((c) => /the runtime's/.test(c.name)));
    assert.ok(failures(judgeKmsProbe({ status: "ran", results: { bound_ms: 3_000, samples_per_key: 3, identities: { ok: true }, keys: { relayer: { opened: true, key: "x", samples: [{ ms: 10, verified: true }] } } } })).length >= 3);
    assert.match(failures(judgeKmsProbe({ status: "not-run", reason: "escrow is null" }))[0].detail, /required/);
  });
});

/* ------------------------------------------------------------------ */
/* §9 The WebSocket paths, parsed                                       */
/* ------------------------------------------------------------------ */

describe("L6-6 §9: the WebSocket results", () => {
  const bounds = { albIdleSeconds: 300, originReadTimeoutSeconds: 60 };
  const idleWith = async (observation: (hold: number) => SocketObservation) => judgeWsIdle((await edgeRecord(fakeEdge({ idle: observation }))).sections, bounds);

  test("the required interval is pinned from the server's keepalive and the evidence's bounds", () => {
    assert.equal(requiredIdleMs(300, 60), 350_000, "max(ALB 300 s, CloudFront 60 s, pong 60 s) + 2 x 25 s");
    assert.equal(requiredIdleMs(120, 60), 170_000);
  });

  test("an idle socket kept open by the server's pings for the whole interval passes", async () => {
    assert.deepEqual(failures(await idleWith((hold) => ({ upgrade_status: null, opened: true, events: [...pingsUntil(hold), { at_ms: hold, kind: "close", code: 1000, clean: true }], ended_by: "probe", duration_ms: hold }))), []);
  });

  test("a socket cut early is attributed: the ALB by timing, the server by its close frame, pings not crossing", async () => {
    const alb = await idleWith(() => ({ upgrade_status: null, opened: true, events: [...pingsUntil(300_500), { at_ms: 300_500, kind: "close", code: 1006, clean: false }], ended_by: "remote", duration_ms: 300_500 }));
    assert.match(failures(alb).map((c) => c.detail).join("\n"), /closed by the ALB .*inferred from timing/);
    const server = await idleWith(() => ({ upgrade_status: null, opened: true, events: [...pingsUntil(120_000), { at_ms: 120_000, kind: "close", code: 4401, clean: true }], ended_by: "remote", duration_ms: 120_000 }));
    assert.match(failures(server).map((c) => c.detail).join("\n"), /the server \(close frame 4401\)/);
    const noPings = await idleWith(() => ({ upgrade_status: null, opened: true, events: [{ at_ms: 61_000, kind: "close", code: 1006, clean: false }], ended_by: "remote", duration_ms: 61_000 }));
    assert.match(failures(noPings).map((c) => c.detail).join("\n"), /no server ping ever delivered|no ping arrived/);
    assert.match(closedBy({ events: [{ kind: "ping", at_ms: 25_000 }, { kind: "close", at_ms: 61_000, clean: false }] }, { albIdleMs: 300_000, originReadMs: 60_000 }), /CloudFront/);
    const refused = await idleWith(() => ({ upgrade_status: 401, opened: false, events: [], ended_by: "remote", duration_ms: 20 }));
    assert.match(failures(refused).map((c) => c.detail).join("\n"), /HTTP 401/);
  });

  test("a probe held shorter than the evidence requires FAILS even if it 'survived'", async () => {
    const record = await edgeRecord(fakeEdge({ idle: () => ({ upgrade_status: null, opened: true, events: pingsUntil(200_000), ended_by: "probe", duration_ms: 200_000 }) }));
    (record.sections as any).ws_idle.required_ms = 190_000;
    (record.sections as any).ws_idle.hold_ms = 200_000;
    assert.ok(failures(judgeWsIdle(record.sections, bounds)).length >= 2);
  });

  test("the idle socket stands the browser's lobby subscription on open; the announcement socket sends nothing", async () => {
    const edge = fakeEdge();
    const record = await edgeRecord(edge);
    assert.equal(LOBBY_SUBSCRIPTION, JSON.stringify({ kind: "rooms-watch", on: true }), "exactly what roomLink.ts stands");
    assert.deepEqual(edge.sends.map(([u, sent]) => [new URL(u).searchParams.get("cp"), sent]), [["9", undefined], ["1", LOBBY_SUBSCRIPTION]]);
    const idle = (record.sections as any).ws_idle;
    assert.equal(idle.subscription, LOBBY_SUBSCRIPTION);
    assert.ok(idle.hold_ms >= idle.required_ms && idle.required_ms === requiredIdleMs(300, 60), "the full required interval is still held");
    assert.deepEqual(failures(judgeWsIdle(record.sections, bounds)), []);
    assert.deepEqual(failures(judgeWsAnnouncement(record.sections)), [], "the announcement probe is unchanged");
  });

  test("subscribed, but closed by the server before the interval (the 60 s reap seen on staging) FAILS", async () => {
    const reaped = await idleWith(() => ({ upgrade_status: null, opened: true, events: [{ at_ms: 14_946, kind: "ping" }, { at_ms: 39_945, kind: "ping" }, { at_ms: 60_012, kind: "close", code: 1000, clean: true }], ended_by: "remote", duration_ms: 60_013 }));
    assert.match(failures(reaped).map((c) => c.detail).join("\n"), /ended after 60013 ms: closed by the server \(close frame 1000\)/);
    const edgeCut = await idleWith(() => ({ upgrade_status: null, opened: true, events: [...pingsUntil(200_000), { at_ms: 200_000, kind: "close", code: 1006, clean: false }], ended_by: "remote", duration_ms: 200_000 }));
    assert.ok(failures(edgeCut).some((c) => /survived/.test(c.name)), "an edge dying inside the interval still fails");
  });

  test("an idle record without the lobby subscription (the pre-fix probe) FAILS the subscription check", async () => {
    const record = await edgeRecord(fakeEdge());
    const idle = (record.sections as any).ws_idle;
    delete idle.subscription;
    idle.observation.events = idle.observation.events.filter((e: SocketEvent) => e.kind !== "sent");
    assert.match(failures(judgeWsIdle(record.sections, bounds)).map((c) => c.name).join("\n"), /lobby subscription stood on open/);
  });

  test("the announcement path: cp=9 must be answered reload/client-protocol and closed 4426", async () => {
    const built = await buildPackage({ edge: await edgeRecord(fakeEdge({ refused: () => ({ upgrade_status: null, opened: true, events: [{ at_ms: 10_000, kind: "ping" }], ended_by: "probe", duration_ms: 20_000 }) })) });
    try {
      assert.match(gateFailures((await verdictOf(built)).result, "websocket").join("\n"), /a stripped cp reads as the legacy wire/);
    } finally {
      cleanup(built.dir);
    }
  });

  test("the Node transport against a real `ws` server: pings recorded, a refusal frame and 4426 parsed, an upgrade refusal's status", async () => {
    const server = http.createServer((_req, res) => res.end());
    const wss = new WebSocketServer({ noServer: true });
    const received: Array<[string | null, string]> = [];
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.headers.cookie === undefined) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("message", (data) => received.push([url.searchParams.get("cp"), String(data)]));
        if (url.searchParams.get("cp") === "9") {
          ws.send(JSON.stringify({ kind: "reload", code: "client-protocol", accepted: [0, 1] }));
          ws.close(4426, "reload");
          return;
        }
        const timer = setInterval(() => ws.ping(), 20);
        ws.on("close", () => clearInterval(timer));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const t = nodeEdgeTransport();
      const refused = await t.observeSocket(`ws://127.0.0.1:${port}/gs?cp=9&cr=11`, { Cookie: "__Host-gs_session=x" }, 2_000);
      assert.equal(refused.opened, true);
      assert.deepEqual(refused.events.filter((e) => e.kind !== "ping").map((e) => [e.kind, e.frame_kind ?? e.code]), [["message", "reload"], ["close", 4426]]);
      const idle = await t.observeSocket(`ws://127.0.0.1:${port}/gs?cp=1&cr=11`, { Cookie: "__Host-gs_session=x" }, 150, LOBBY_SUBSCRIPTION);
      assert.equal(idle.ended_by, "probe");
      assert.ok(idle.events.filter((e) => e.kind === "ping").length >= 3, JSON.stringify(idle.events));
      assert.deepEqual(idle.events.filter((e) => e.kind === "sent").map((e) => e.frame_kind), ["rooms-watch"], "the one frame sent on open is recorded");
      assert.deepEqual(received, [["1", LOBBY_SUBSCRIPTION]], "the server received exactly the lobby subscription, on the idle socket only");
      const unauth = await t.observeSocket(`ws://127.0.0.1:${port}/gs?cp=1&cr=11`, {}, 150);
      assert.equal(unauth.upgrade_status, 401);
      assert.equal(unauth.opened, false);
    } finally {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/* ------------------------------------------------------------------ */
/* §10 Secrets and determinism                                          */
/* ------------------------------------------------------------------ */

describe("L6-6 §10: no secret in the package; a deterministic report", () => {
  test("secret-shaped material is refused by the writer and flagged by the reader", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-l66-secret-"));
    try {
      const secrets: unknown[] = [
        { key: "AKIAABCDEFGHIJKLMNOP" },
        { header: "__Host-gs_session=v1.abcdefgh.0123456789abcdef0123" },
        { value: "v1.sessionid00.secretsecretsecretsecret" },
        { cookie: "x" },
        { note: "-----BEGIN EC PRIVATE KEY-----" },
        { token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop" },
        { SessionToken: "IQoJb3JpZ2luX2VjE" },
        { principal_id: "p-123" },
        { mnemonic: "abandon abandon" },
        { wallet_proof: {} },
        { recovery_key: "r" },
      ];
      for (const s of secrets) assert.throws(() => writeRecord(dir, "x.json", s), EvidenceRefusedError, JSON.stringify(s));
      assert.equal(fs.existsSync(path.join(dir, "x.json")), false, "nothing written");
      fs.writeFileSync(path.join(dir, "leak.json"), JSON.stringify({ Authorization: "Bearer x", "set-cookie": "a" }));
      const read = readEvidence(dir, "leak.json");
      assert.equal(read.ok, false);
      assert.deepEqual(secretFindings(JSON.stringify({ digest: "ab".repeat(32), public_key_hex: "03".padEnd(66, "a"), arn: "arn:aws:iam::1:role/x", query_sha256: "cd".repeat(32) })), [], "hashes, public keys and ARNs are not secrets");
    } finally {
      cleanup(dir);
    }
  });

  test("the session cookie never reaches a record, even when an error quotes it", async () => {
    const cookie = "v1.sessionid00.secretsecretsecretsecret";
    const quoting: EdgeTransport = {
      async get() {
        throw new Error(`upstream said: Cookie __Host-gs_session=${cookie}`);
      },
      async observeSocket() {
        return { upgrade_status: null, opened: false, events: [{ at_ms: 1, kind: "error", error: `boom ${cookie}` }], ended_by: "error", duration_ms: 1 };
      },
    };
    const record = await edgeRecord(quoting, { cookie });
    const text = JSON.stringify(record);
    assert.ok(!text.includes(cookie), text);
    assert.ok(text.includes("<redacted>"));
  });

  test("the same evidence gives the same bytes: certification.json, CERTIFICATION.txt, certification-manifest.json", async () => {
    const built = await buildPackage();
    try {
      const ctx = await built.ctx();
      const first = certify(ctx);
      writeCertification(ctx, first);
      const bytes = [EVIDENCE.certification, EVIDENCE.certificationText, EVIDENCE.manifest].map((f) => fs.readFileSync(path.join(built.dir, f), "utf8"));
      const again = certify(await built.ctx());
      writeCertification(ctx, again);
      assert.deepEqual([EVIDENCE.certification, EVIDENCE.certificationText, EVIDENCE.manifest].map((f) => fs.readFileSync(path.join(built.dir, f), "utf8")), bytes);
      assert.equal(bytes[1].split("\n")[0], "LIVE-6 AWS STAGING CERTIFICATION: PASS");
      const json = JSON.parse(bytes[0]);
      assert.equal(json.verdict, "PASS");
      assert.deepEqual(json.failed_gates, []);
      assert.equal(json.build_id, "2026-09-30-test");
      assert.ok(JSON.parse(bytes[2]).files.some((f: any) => f.file === "terraform/app/plan.json"));
      assert.equal(stableStringify({ b: 1, a: { d: 1, c: 2 } }), stableStringify({ a: { c: 2, d: 1 }, b: 1 }));
    } finally {
      cleanup(built.dir);
    }
  });
});

/* ------------------------------------------------------------------ */
/* §11 No probe reaches production authority                            */
/* ------------------------------------------------------------------ */

describe("L6-6 §11: a probe or a diagnostic can never mutate production authority", () => {
  test("the disposable guard refuses, BEFORE sending, anything outside L6CERT#<run> of the game table", async () => {
    const sent: string[] = [];
    const raw = { send: async (c: { constructor: { name: string } }) => void sent.push(c.constructor.name) } as never;
    const guarded = disposableOnly(raw, "gs-staging-game-g1", `L6CERT#${RUN}`);
    const { TransactWriteItemsCommand, PutItemCommand, DeleteItemCommand, ScanCommand, QueryCommand, UpdateItemCommand } = await import("@aws-sdk/client-dynamodb");
    const refused = [
      new TransactWriteItemsCommand({ TransactItems: [{ Put: { TableName: "gs-staging-game-g1", Item: { pk: { S: "SYSTEM" }, sk: { S: "ROUTING" } } } }] }),
      new TransactWriteItemsCommand({ TransactItems: [{ Put: { TableName: "gs-staging-game-g1", Item: { pk: { S: `L6CERT#${RUN}` }, sk: { S: "a" } } } }, { ConditionCheck: { TableName: "gs-staging-game-g1", Key: { pk: { S: "POOL#p1" }, sk: { S: "POOL" } }, ConditionExpression: "x" } }] }),
      new PutItemCommand({ TableName: "gs-staging-game-g1", Item: { pk: { S: "GAME#g1" }, sk: { S: "HEAD" } } }),
      new DeleteItemCommand({ TableName: "arn:aws:dynamodb:us-east-1:222222222222:table/gs-staging-ledger", Key: { pk: { S: `L6CERT#${RUN}` }, sk: { S: "a" } } }),
      new UpdateItemCommand({ TableName: "gs-staging-game-g1", Key: { pk: { S: `L6CERT#${RUN}x` }, sk: { S: "a" } }, UpdateExpression: "SET a = :a" }),
      new ScanCommand({ TableName: "gs-staging-game-g1" }),
      new QueryCommand({ TableName: "gs-staging-game-g1", KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": { S: "SYSTEM" } } }),
    ];
    for (const command of refused) await assert.rejects((guarded.send as (c: unknown) => Promise<unknown>)(command), DisposableGuardError, command.constructor.name);
    assert.deepEqual(sent, [], "nothing reached the client");
    await (guarded.send as (c: unknown) => Promise<unknown>)(new PutItemCommand({ TableName: "gs-staging-game-g1", Item: { pk: { S: `L6CERT#${RUN}` }, sk: { S: "a" } } }));
    assert.deepEqual(sent, ["PutItemCommand"]);
  });

  test("the transaction probe, even when every call fails in every way, sends nothing outside its partition and still cleans up", async () => {
    for (const failure of ["TimeoutError", "ThrottlingException", "InternalServerError", "TransactionCanceledException"]) {
      const sent: Array<{ name: string; pks: string[] }> = [];
      const client = {
        async send(command: { constructor: { name: string }; input: Record<string, any> }) {
          const i = command.input;
          const pks =
            command.constructor.name === "TransactWriteItemsCommand"
              ? (i.TransactItems as any[]).map((t) => String((t.Put?.Item ?? (t.Update ?? t.Delete ?? t.ConditionCheck).Key).pk.S))
              : command.constructor.name === "QueryCommand"
                ? [String(i.ExpressionAttributeValues[":pk"].S)]
                : [String((i.Item ?? i.Key).pk.S)];
          sent.push({ name: command.constructor.name, pks });
          if (command.constructor.name === "QueryCommand") return { Items: sent.length > 1 ? [{ sk: { S: "T1-A" } }] : [] };
          if (command.constructor.name === "DeleteItemCommand") return {};
          throw Object.assign(new Error("injected"), { name: failure, CancellationReasons: [{ Code: "ThrottlingError" }] });
        },
      };
      const record = await runTransactionProbe(client as never, { run: RUN, gameTable: "gs-staging-game-g1", conflictRounds: 1, conflictWriters: 2, timing: { windowMs: 0, maxResends: 0, sleep: async () => undefined } });
      assert.ok(sent.every((s) => s.pks.every((pk) => pk === `L6CERT#${RUN}`)), `${failure}: ${JSON.stringify(sent.filter((s) => s.pks.some((pk) => pk !== `L6CERT#${RUN}`)))}`);
      assert.ok(sent.some((s) => s.name === "DeleteItemCommand"), `${failure}: the cleanup ran`);
      assert.ok(failures(judgeTransactionProbe({ status: "ran", results: record })).length > 0, `${failure}: a broken service is never a PASS`);
    }
  });

  test("the IAM probe's guard refuses a ROUTING write, a write without the impossible condition, APPGEN in an 'allowed' probe", () => {
    const ctx = { run: RUN, gameTable: "g", ledgerTable: "arn:l", nonce: "n" };
    for (const spec of iamProbeSpecs(ctx)) assert.equal(iamProbeWriteProblem(spec, ctx), null, spec.id);
    const [put] = iamProbeSpecs(ctx);
    const routing = { ...put, transact: [{ Put: { ...put.transact?.[0].Put, Item: { pk: { S: "SYSTEM" }, sk: { S: "ROUTING" } } } }] } as never;
    assert.match(String(iamProbeWriteProblem(routing, ctx)), /SYSTEM\/ROUTING/);
    const unguarded = { ...put, transact: [{ Put: { ...put.transact?.[0].Put, ConditionExpression: "attribute_not_exists(pk)" } }] } as never;
    assert.match(String(iamProbeWriteProblem(unguarded, ctx)), /without the impossible condition/);
    const ledgerAllow = iamProbeSpecs(ctx).find((s) => s.id === "ledger-deny-transact-put-appgen");
    assert.match(String(iamProbeWriteProblem({ ...ledgerAllow, expect: "allow" } as never, ctx)), /APPGEN is only ever/);
    const pool = { ...put, transact: [{ ConditionCheck: { TableName: "g", Key: { pk: { S: "POOL#p1" }, sk: { S: "POOL" } }, ConditionExpression: "attribute_exists(pk)" } }] } as never;
    assert.match(String(iamProbeWriteProblem(pool, ctx)), /ConditionCheck on POOL#p1/);
  });

  test("the KMS probe touches no store, no chain and no ledger: only GetPublicKey and Sign", async () => {
    const clock = { now: 0 };
    const kms = fakeKms({ clock });
    await runKmsProbe(junoConfig(), { kms: kms.client, clock: () => clock.now }, { run: RUN, samples: 2 });
    assert.ok(kms.calls.every((c) => /^(GetPublicKey|Sign) arn:aws:kms:/.test(c)));
  });

  test("stage-cert and the edge probe send only reads: the certification's AWS calls are Describe / Get / List", async () => {
    const built = await buildPackage({ part: "all", skip: [EVIDENCE.verifyLedger] });
    const seen: string[] = [];
    const recorder = (label: string) =>
      ({
        async send(command: { constructor: { name: string } }) {
          seen.push(`${label} ${command.constructor.name}`);
          throw Object.assign(new Error("offline"), { name: "ResourceNotFoundException" });
        },
        config: { region: async () => "us-east-1" },
      }) as never;
    const deps: DeployDeps = { parameters: PARAMETERS, dynamo: () => recorder("dynamo"), kms: () => ({ sdk: recorder("kms"), digest: fakeKms().client }), now: () => Date.parse("2026-09-30T11:00:00Z"), out: () => undefined };
    const staging: StagingDeps = { env: {}, monotonic: () => 0, edge: fakeEdge(), repository: REPO };
    try {
      const code = await stageCertCommand(["certify", "--run-id", RUN, "--evidence", built.dir, "--runtime-parameter", RUNTIME_ARN, "--environment", "staging", "--primary-pool", "p1", "--generation", "1", "--part", "all", "--scenario", "read-only", "--commit", "aa2c64c"], deps, staging);
      assert.equal(code, 1, "the offline tables fail the prerequisite");
      assert.ok(seen.length > 0 && seen.every((s) => /(Describe|Get|List)[A-Za-z]*Command$/.test(s)), JSON.stringify(seen));
      assert.equal(fs.readFileSync(path.join(built.dir, EVIDENCE.certificationText), "utf8").split("\n")[0], "LIVE-6 AWS STAGING CERTIFICATION: FAIL");
    } finally {
      cleanup(built.dir);
    }
    const edge = fakeEdge();
    await edgeRecord(edge);
    assert.ok(edge.urls.every((u) => /\/gs\/diag\/edge\?|\/gs\?/.test(u)));
  });

  test("the edge diagnostic: a hashed mirror, GET only, fail-closed hops; mounted only by `staging`, never on mainnet or prod", () => {
    const answer = edgeDiagnosticAnswer({ url: "/gs/diag/edge?cp=1&cr=11&cb=b1&secret=hunter2", headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.5, 130.176.0.1" }, socket: {} } as never, 2);
    const text = JSON.stringify(answer);
    assert.ok(!text.includes("hunter2") && !text.includes("203.0.113.5") && !text.includes("secret"), text);
    assert.equal(answer.forwarded_entries, 3);
    assert.deepEqual(answer.announcement, { kind: "announced", protocol: 1, rules: [11], build: "b1" });
    const short = edgeDiagnosticAnswer({ url: "/gs/diag/edge", headers: { "x-forwarded-for": "130.176.0.1" }, socket: {} } as never, 2);
    assert.equal(short.client_key_sha256, null);
    assert.match(String(short.client_key_problem), /fewer X-Forwarded-For entries/);
    const res = { status: 0, headers: {} as Record<string, string>, body: "", writeHead(s: number, h: Record<string, string>) { this.status = s; this.headers = h; }, end(b?: string) { this.body = b ?? ""; } };
    assert.equal(handleEdgeDiagnostic({ url: "/gs/diag/edge", method: "POST", headers: {}, socket: {} } as never, res as never, { trustedProxyHops: 2 }), true);
    assert.equal(res.status, 405);
    assert.equal(handleEdgeDiagnostic({ url: "/gs/readyz", method: "GET", headers: {}, socket: {} } as never, res as never, { trustedProxyHops: 2 }), false);
    const none = { environment: "staging", escrow: null };
    assert.deepEqual(edgeDiagnosticSwitch(undefined, none), { ok: true, enabled: false });
    assert.deepEqual(edgeDiagnosticSwitch("staging", none), { ok: true, enabled: true });
    assert.equal(edgeDiagnosticSwitch("on", none).ok, false);
    assert.equal(edgeDiagnosticSwitch("staging", { environment: "staging", escrow: { networkClass: "mainnet", chainId: "juno-1" } }).ok, false);
    assert.equal(edgeDiagnosticSwitch("staging", { environment: "staging", escrow: { networkClass: "testnet", chainId: "juno-1" } }).ok, false);
    assert.equal(edgeDiagnosticSwitch("staging", { environment: "prod", escrow: null }).ok, false);
    assert.deepEqual(edgeDiagnosticSwitch("staging", { environment: "staging", escrow: { networkClass: "testnet", chainId: "uni-7" } }), { ok: true, enabled: true });
  });

  test("the verifier accepts GS_EDGE_DIAGNOSTIC only as `staging`", async () => {
    const built = await buildPackage({ mutate: { [EVIDENCE_FILES.taskDefinition("p1")]: (v) => ((v.taskDefinition.containerDefinitions[0].environment.find((e: any) => e.name === "GS_EDGE_DIAGNOSTIC").value = "on"), v) } });
    try {
      assert.match(gateFailures((await verdictOf(built)).result, "prerequisite").join("\n"), /environment values.*GS_EDGE_DIAGNOSTIC=on/);
    } finally {
      cleanup(built.dir);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The commands                                                         */
/* ------------------------------------------------------------------ */

describe("L6-6: the commands' refusals and the in-task record's round trip", () => {
  const deps = (out: string[]): DeployDeps => ({ parameters: PARAMETERS, dynamo: () => ({}) as never, kms: () => ({ sdk: {} as never, digest: fakeKms().client }), now: () => 0, out: (l) => void out.push(l) });
  const staging: StagingDeps = { env: {}, monotonic: () => 0, edge: fakeEdge(), repository: REPO };
  const run = (argv: string[], out: string[] = []) =>
    runDeployCommand(argv, deps(out), { "stage-cert": (a) => stageCertCommand(a, deps(out), staging), "stage-probe": (a) => stageProbeCommand(a, deps(out), staging) });

  test("usage refusals: a bad run id, no scenario, --replaced-pools on read-only, a mistyped --disposable-writes, a plain-http edge", async () => {
    const out: string[] = [];
    assert.equal(await run(["stage-cert", "certify", "--run-id", "BAD", "--evidence", "/tmp/x"], out), EXIT_USAGE);
    assert.equal(await run(["stage-cert", "certify", "--run-id", RUN, "--evidence", "/tmp/x", "--runtime-parameter", RUNTIME_ARN, "--environment", "staging", "--primary-pool", "p1", "--generation", "1", "--commit", "abc1234"], out), EXIT_USAGE);
    assert.equal(await run(["stage-cert", "certify", "--run-id", RUN, "--evidence", "/tmp/x", "--scenario", "read-only", "--replaced-pools", "p1", "--commit", "abc1234"], out), EXIT_USAGE);
    assert.equal(await run(["stage-probe", "task-role", "--run-id", RUN, "--runtime-parameter", RUNTIME_ARN, "--environment", "staging", "--generation", "1", "--pool", "p1", "--disposable-writes", "SYSTEM"], out), EXIT_USAGE);
    assert.equal(await run(["stage-probe", "task-role", "--run-id", RUN, "--runtime-parameter", RUNTIME_ARN, "--environment", "prod", "--generation", "1", "--pool", "p1", "--disposable-writes", `L6CERT#${RUN}`], out), EXIT_USAGE);
    assert.equal(await run(["stage-probe", "edge", "--run-id", RUN, "--evidence", "/tmp/x", "--base-url", "http://play.example.com", "--origin", "https://play.example.com", "--environment", "staging", "--generation", "1", "--pool", "p1"], out), EXIT_USAGE);
    assert.equal(await run(["stage-cert", "certify", "--force"], out), EXIT_USAGE, "there is no --force");
    assert.match(out.join("\n"), /--run-id must match/);
    assert.match(out.join("\n"), /--disposable-writes must be exactly L6CERT#/);
    assert.match(out.join("\n"), /never writes in a prod\* environment/);
  });

  test("the edge probe refuses to run before a PASSing prerequisite for this run", async () => {
    const built = await buildPackage({ mutate: { [EVIDENCE.prerequisite]: (v) => ({ ...v, verdict: "FAIL" }) } });
    const out: string[] = [];
    try {
      assert.equal(await run(["stage-probe", "edge", "--run-id", RUN, "--evidence", built.dir, "--base-url", "https://play.example.com", "--origin", "https://play.example.com", "--environment", "staging", "--generation", "1", "--pool", "p1"], out), EXIT_USAGE);
      assert.match(out.join("\n"), /not PASS for l6cert-test-0930/);
    } finally {
      cleanup(built.dir);
    }
  });

  test("the edge probe command writes a record the certification accepts (and --hold-seconds can only lengthen the hold)", async () => {
    const built = await buildPackage({ skip: [EVIDENCE.edge] });
    const out: string[] = [];
    const cookieDeps: StagingDeps = { ...staging, env: { GS_CERT_SESSION_COOKIE: "v1.sessionid00.secretsecretsecretsecret" } };
    const clock = { t: Date.parse("2026-09-30T10:10:00Z") };
    const d: DeployDeps = { ...deps(out), now: () => (clock.t += 1000) };
    try {
      assert.equal(await stageProbeCommand(["edge", "--run-id", RUN, "--evidence", built.dir, "--base-url", "https://play.example.com", "--origin", "https://play.example.com", "--environment", "staging", "--generation", "1", "--pool", "p1", "--hold-seconds", "60"], d, cookieDeps).catch((e: Error) => e.message), "--hold-seconds must be at least 350 (the path's longest idle bound plus two server ping periods)");
      assert.equal(await stageProbeCommand(["edge", "--run-id", RUN, "--evidence", built.dir, "--base-url", "https://play.example.com", "--origin", "https://play.example.com", "--environment", "staging", "--generation", "1", "--pool", "p1", "--expected-client-ip", VIEWER_IP], d, cookieDeps), 0);
      const text = fs.readFileSync(path.join(built.dir, EVIDENCE.edge), "utf8");
      assert.ok(!text.includes("secretsecret"));
      const { result } = await verdictOf(built);
      assert.deepEqual(failedGates(result).filter((g) => ["proxy-hops", "query-strings", "websocket"].includes(g)), [], JSON.stringify(["proxy-hops", "query-strings", "websocket"].map((g) => gateFailures(result, g))));
    } finally {
      cleanup(built.dir);
    }
  });

  test("the in-task record survives CloudWatch: chunked lines, reassembled, checked, collected", async () => {
    const record = await taskRoleRecord();
    const lines = recordLines(record);
    assert.ok(lines.length >= 2 && lines.every((l) => l.length < 16_384), "each line under Docker's 16 KiB split");
    const got = recordFromLog(["  aws: noise", ...lines.slice().reverse(), "done"]);
    assert.equal(got.ok, true);
    assert.equal(stableStringify(got.ok ? got.record : null), stableStringify(record));
    assert.equal(recordFromLog(lines.slice(1)).ok, false, "a missing chunk");
    const bad = [...lines];
    bad[0] = `${bad[0].slice(0, -10)}${bad[0].endsWith("AAAAAAAAAA") ? "BBBBBBBBBB" : "AAAAAAAAAA"}`;
    assert.equal(recordFromLog(bad).ok, false, "a corrupted chunk fails its SHA-256");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-l66-collect-"));
    try {
      write(dir, EVIDENCE.taskRoleLog, { events: lines.map((message, i) => ({ timestamp: i, message })) });
      const out: string[] = [];
      assert.equal(await run(["stage-probe", "collect", "--run-id", RUN, "--evidence", dir], out), 0);
      assert.equal(await run(["stage-probe", "collect", "--run-id", "l6cert-other-run", "--evidence", dir], out), 1);
      assert.equal(stableStringify(JSON.parse(fs.readFileSync(path.join(dir, EVIDENCE.taskRole), "utf8"))), stableStringify(record));
    } finally {
      cleanup(dir);
    }
  });

  test("the probe query is non-default and carries unrelated material", () => {
    const q = probeQuery(RUN);
    assert.deepEqual(q.slice(0, 3).map(([n]) => n), ["cp", "cr", "cb"]);
    assert.notEqual(q[0][1], "1", "cp is not the bundle's default");
    assert.ok(q.filter(([n]) => !["cp", "cr", "cb"].includes(n)).length >= 4);
  });
});

/* ------------------------------------------------------------------ */
/* The adversarial review's findings, pinned                            */
/* ------------------------------------------------------------------ */

describe("L6-6 review: forged, stale and incomplete evidence is refused", () => {
  const DRAINED = "arn:aws:ecs:us-east-1:111111111111:task/gs-staging/0ld0000000000000000000000000000";
  const drainFiles = (overrides: { stamp?: Record<string, unknown>; exitCode?: number; stoppedAt?: string } = {}) => ({
    "drain-p1/tasks-before.json": { tasks: [{ taskArn: DRAINED, group: "service:gs-staging-p1", lastStatus: "RUNNING", taskDefinitionArn: TD.replace(":7", ":6"), createdAt: "2026-09-29T09:00:00Z" }] },
    "drain-p1/tasks-after.json": { tasks: [{ taskArn: DRAINED, group: "service:gs-staging-p1", lastStatus: "STOPPED", stoppedAt: overrides.stoppedAt ?? "2026-09-30T08:55:00.000000+00:00", containers: [{ name: "game-server", exitCode: overrides.exitCode ?? 0 }] }] },
    "drain-p1/service-after.json": { services: [{ serviceName: "gs-staging-p1", desiredCount: 0, runningCount: 0, pendingCount: 0 }] },
    "drain-p1/drain.json": { format: "18COSMOS/L6-6-DRAIN/v1", run_id: RUN, pool: "p1", drained_at: "2026-09-30T08:56:00Z", ...(overrides.stamp ?? {}) },
  });
  const withDrain = async (files: Record<string, unknown>) => {
    const built = await buildPackage();
    for (const [file, value] of Object.entries(files)) write(built.dir, file, value);
    return built;
  };

  test("the replacement scenario PASSES with this run's drain -> zero -> apply/start, and FAILS on another run's drain, an ungraceful exit or an overlap", async () => {
    const good = await withDrain(drainFiles());
    const stale = await withDrain(drainFiles({ stamp: { run_id: "l6cert-last-month" } }));
    const fenced = await withDrain(drainFiles({ exitCode: 3 }));
    const overlap = await withDrain(drainFiles({ stoppedAt: "2026-09-30T09:05:00Z" }));
    try {
      const passed = await verdictOf(good, { scenario: "replacement", replacedPools: ["p1"] });
      assert.deepEqual(failedGates(passed.result), [], JSON.stringify(gateFailures(passed.result, "drain")));
      assert.equal(passed.result.gates.find((g) => g.id === "drain")?.status, "pass");
      assert.match(gateFailures((await verdictOf(stale, { scenario: "replacement", replacedPools: ["p1"] })).result, "drain").join("\n"), /another run proves nothing/);
      assert.match(gateFailures((await verdictOf(fenced, { scenario: "replacement", replacedPools: ["p1"] })).result, "drain").join("\n"), /exit 3 is a fenced task/);
      assert.match(gateFailures((await verdictOf(overlap, { scenario: "replacement", replacedPools: ["p1"] })).result, "drain").join("\n"), /overlap/);
    } finally {
      for (const b of [good, stale, fenced, overlap]) cleanup(b.dir);
    }
  });

  test("a task-role record that is not the certifier task's own -- another task, or not what its log printed -- FAILS", async () => {
    const elsewhere = await buildPackage({ taskRole: await taskRoleRecord({ runner: { task_arn: "arn:aws:ecs:us-east-1:111111111111:task/gs-staging/laptop" } }) });
    const doctored = await buildPackage({ mutate: { [EVIDENCE.taskRole]: (v) => ((v.sections.kms.results.keys.relayer.samples[0].ms = 1), v) } });
    const noLog = await buildPackage({ skip: [EVIDENCE.taskRoleLog] });
    try {
      assert.match(gateFailures((await verdictOf(elsewhere)).result, "iam").join("\n"), /the record is the certifier task's/);
      assert.match(gateFailures((await verdictOf(doctored)).result, "iam").join("\n"), /differs from the one in the log/);
      assert.match(gateFailures((await verdictOf(noLog)).result, "iam").join("\n"), /probe-task-role-log.json is missing/);
    } finally {
      for (const b of [elsewhere, doctored, noLog]) cleanup(b.dir);
    }
  });

  test("an IAM record that relabels a forbidden probe as 'allow' is judged by the build's own spec, and FAILS", async () => {
    const { results } = await runIamProbe({ game: iamDynamo({ enforce: false }).client, ledger: iamDynamo({ enforce: false }).client }, { run: RUN, gameTable: "g", ledgerTable: "arn:l", nonce: "n" });
    const relabelled = results.map((r) => ({ ...r, expect: "allow", item_count: 1, probe_index: 0 }));
    const checks = judgeIamProbe({ status: "ran", results: relabelled }, "gs-staging-app-task", IAM_PROBE_IDS);
    assert.ok(failures(checks).length >= 9, JSON.stringify(failures(checks)));
    const duplicated = judgeIamProbe({ status: "ran", results: [...results, results[0]] }, "gs-staging-app-task", IAM_PROBE_IDS);
    assert.ok(failures(duplicated).some((c) => /recorded twice/.test(c.detail)));
  });

  test("an empty or partial cluster listing is not proof that nothing runs beside the services", async () => {
    const empty = await buildPackage({ mutate: { [EVIDENCE.clusterTasks]: () => clusterListing([]) } });
    const legacy = await buildPackage({ mutate: { [EVIDENCE.clusterTasks]: () => ({ tasks: [], failures: [] }) } });
    try {
      assert.match(gateFailures((await verdictOf(empty)).result, "prerequisite").join("\n"), /the cluster listing is incomplete/);
      assert.match(gateFailures((await verdictOf(legacy)).result, "prerequisite").join("\n"), /the cluster listing is complete: .*single desired-RUNNING answer/);
    } finally {
      cleanup(empty.dir);
      cleanup(legacy.dir);
    }
  });

  test("another run's plan, a plan older than the prerequisite, another run's ledger verification -- each FAILS", async () => {
    const otherPlan = await buildPackage({ mutate: { "terraform/app/run.json": (v) => ({ ...v, run_id: "l6cert-other" }) } });
    const oldPlan = await buildPackage({ mutate: { "terraform/ledger/plan.json": (v) => ({ ...v, timestamp: "2026-08-30T10:00:00Z" }) } });
    const oldLedger = await buildPackage({ mutate: { [EVIDENCE.verifyLedger]: (v) => ({ ...v, run_id: "l6cert-other" }) } });
    try {
      assert.match(gateFailures((await verdictOf(otherPlan)).result, "terraform").join("\n"), /run l6cert-other's/);
      assert.match(gateFailures((await verdictOf(oldPlan)).result, "terraform").join("\n"), /before the prerequisite/);
      assert.match(gateFailures((await verdictOf(oldLedger)).result, "prerequisite").join("\n"), /run l6cert-other/);
    } finally {
      for (const b of [otherPlan, oldPlan, oldLedger]) cleanup(b.dir);
    }
  });

  test("an in-place update that lowers a protection FAILS; a task-definition replacement needs skip_destroy in the PRIOR state", () => {
    const judge = (extra: unknown) => failures(judgeTerraformStack("app", { version: TERRAFORM_VERSION, plan: appPlan({ extra: [extra] }), exitCode: "2", lock: lockText("app") }, lockText("app"), { primaryPool: "p1" }).checks);
    const update = (type: string, before: Record<string, unknown>, after: Record<string, unknown>) => ({ address: `module.app.${type}.x`, mode: "managed", type, change: { actions: ["update"], before, after } });
    assert.match(judge(update("aws_dynamodb_table", { deletion_protection_enabled: true }, { deletion_protection_enabled: false })).map((c) => c.detail).join(), /deletion protection off/);
    assert.match(judge(update("aws_dynamodb_table", {}, { deletion_protection_enabled: true, point_in_time_recovery: [{ enabled: false }] })).map((c) => c.detail).join(), /point-in-time recovery off/);
    assert.match(judge(update("aws_kms_key", { is_enabled: true }, { is_enabled: false })).map((c) => c.detail).join(), /the key disabled/);
    assert.match(judge(update("aws_ecs_service", {}, { deployment_minimum_healthy_percent: 100 })).map((c) => c.detail).join(), /no longer stop-first/);
    assert.deepEqual(judge(update("aws_ssm_parameter", { insecure_value: "a" }, { insecure_value: "b" })), [], "a document change is a normal update");
    const late = appPlan();
    (late.resource_changes[1] as any).change.before.skip_destroy = false;
    assert.ok(failures(judgeTerraformStack("app", { version: TERRAFORM_VERSION, plan: late, exitCode: "2", lock: lockText("app") }, lockText("app"), { primaryPool: "p1" }).checks).some((c) => /nothing destroyed or replaced/.test(c.name)));
  });

  test("a rerun removes the previous outputs first: a refused certify never leaves an older PASS behind", async () => {
    const built = await buildPackage();
    try {
      const ctx = await built.ctx();
      writeCertification(ctx, certify(ctx));
      assert.ok(fs.existsSync(path.join(built.dir, EVIDENCE.certificationText)));
      const broken: DeployDeps = { parameters: { read: async () => Promise.reject(new Error("SSM unreachable")) }, dynamo: () => ({}) as never, kms: () => ({ sdk: {} as never, digest: fakeKms().client }), now: () => 0, out: () => undefined };
      await assert.rejects(stageCertCommand(["certify", "--run-id", RUN, "--evidence", built.dir, "--runtime-parameter", RUNTIME_ARN, "--environment", "staging", "--primary-pool", "p1", "--generation", "1", "--scenario", "read-only", "--commit", HEAD], broken, { env: {}, monotonic: () => 0, edge: fakeEdge(), repository: REPO }));
      for (const file of [EVIDENCE.certification, EVIDENCE.certificationText, EVIDENCE.manifest]) assert.equal(fs.existsSync(path.join(built.dir, file)), false, file);
      await assert.rejects(stageCertCommand(["prerequisite", "--run-id", RUN, "--evidence", built.dir, "--runtime-parameter", RUNTIME_ARN, "--environment", "staging", "--primary-pool", "p1", "--generation", "1"], broken, { env: {}, monotonic: () => 0, edge: fakeEdge(), repository: REPO }));
      assert.equal(fs.existsSync(path.join(built.dir, EVIDENCE.prerequisite)), false);
    } finally {
      cleanup(built.dir);
    }
  });

  test("the commit must be the checkout's HEAD; the verifier refuses the edge mirror in a prod* environment; a secret hidden in the log's base64 is found", async () => {
    const built = await buildPackage();
    try {
      const wrong = certify(await built.ctx({ commit: "0000000" }));
      assert.match(gateFailures(wrong, "evidence").join("\n"), /is not the checkout's HEAD/);
      const secret = Buffer.from(JSON.stringify({ note: "AKIAABCDEFGHIJKLMNOP" })).toString("base64");
      write(built.dir, "stray-log.json", { events: [{ message: `L6CERT/v1 1/1 ${"0".repeat(64)} ${secret}` }] });
      assert.match(gateFailures(certify(await built.ctx()), "evidence").join("\n"), /stray-log.json: an AWS access key id/);
    } finally {
      cleanup(built.dir);
    }
    const td = clone(TASK_DEFINITION);
    const { checkTaskDefinitionEvidence } = await import("../deployVerify");
    assert.ok(failures(checkTaskDefinitionEvidence("p1", td, { environment: "prod", runtimeParameterArn: RUNTIME_ARN, port: 8917 })).some((c) => /environment values/.test(c.name) && /GS_EDGE_DIAGNOSTIC/.test(c.detail)));
  });

  test("the task-role probe refuses a mainnet escrow configuration, whatever the environment is called", async () => {
    const mainnet = JSON.parse(junoText()) as Record<string, any>;
    mainnet.chain_id = "juno-1";
    mainnet.network_class = "mainnet";
    mainnet.rest_endpoints = ["https://a.example.net", "https://b.example.net"];
    const parameters: ParameterSource = {
      async read(arn) {
        if (arn === JUNO_ARN) return { value: JSON.stringify(mainnet), version: 1, arn };
        return PARAMETERS.read(arn);
      },
    };
    const out: string[] = [];
    const d: DeployDeps = { parameters, dynamo: () => ({}) as never, kms: () => ({ sdk: {} as never, digest: fakeKms().client }), now: () => 0, out: (l) => void out.push(l) };
    const code = await runDeployCommand(["stage-probe", "task-role", "--run-id", RUN, "--runtime-parameter", RUNTIME_ARN, "--environment", "staging", "--generation", "1", "--pool", "p1"], d, { "stage-probe": (a) => stageProbeCommand(a, d, { env: {}, monotonic: () => 0, edge: fakeEdge(), repository: REPO }) });
    assert.notEqual(code, 0);
    assert.match(out.join("\n"), /mainnet escrow configuration: the staging probe refuses/);
  });
});

/* ------------------------------------------------------------------ */
/* L6-4 addendum: the recovery part of the PASS contract                */
/* ------------------------------------------------------------------ */

describe("L6-6 x L6-4: the integrated deployment cannot PASS without generation, binding, identity, review and rollback", () => {
  const {
    judgeGeneration,
    judgeIdentityRecovery,
    judgeReviews,
    judgeRollback,
    judgeRestoreQuiet,
    judgeRestoreFencing,
    RESTORE_STOP_DIR,
    RESTORE_STOP_FORMAT,
    RESTORE_FENCING_FORMAT,
    PRIOR_CERTIFICATIONS,
  } = require("./recovery") as typeof import("./recovery");
  const expect1 = { generation: 1, gameTable: "gs-staging-game-g1", requireRestore: false };
  const gen = async (script: ReaderScript, expect = expect1) => failures(judgeGeneration(await generationOf(script), expect)).map((c) => `${c.name}: ${c.detail}`).join("\n");
  const identity = async (script: ReaderScript) => {
    const section = await readIdentityRecovery(readersFor(script), {} as never, IDENTITY_TABLE);
    return { section, failed: failures(judgeIdentityRecovery(section, IDENTITY_TABLE)).map((c) => `${c.name}: ${c.detail}`).join("\n") };
  };
  const complete: IdentityRestoreFacts = { restore_id: "idr-0930", state: "complete", identity_table: IDENTITY_TABLE, peer_table: "gs-staging-identity-old", restore_point: 5, started_at: 6, journal_digest: "ab".repeat(32), journal_events: 12, completed_at: 7, reviews: 0 };

  test("THIS branch binds no L6-4 reader: every recovery gate FAILS 'not integrated', and so does the certification", async () => {
    const built = await buildPackage({ taskRole: await taskRoleRecord({ identity: null }) });
    try {
      const { result } = await verdictOf(built, { generationEvidence: { integrated: false, marker: null, appgen: null, startupRule: null } });
      assert.equal(result.passed, false);
      for (const gate of ["generation", "identity", "review"]) assert.match(gateFailures(result, gate).join("\n"), /not bound in this build/, gate);
    } finally {
      cleanup(built.dir);
    }
  });

  test("SYSTEM/GENERATION: missing, unreadable, another generation, another table, a malformed form -- each FAIL, never SKIP", async () => {
    assert.equal(await gen({}), "");
    assert.match(await gen({ marker: null }), /carries no SYSTEM\/GENERATION/);
    assert.match(await gen({ marker: new Error("SYSTEM/GENERATION is format 2") }), /unreadable .*format 2/);
    assert.match(await gen({ marker: { ...BOOT_MARKER, generation: 3 } }), /holds generation 3/);
    assert.match(await gen({ marker: { ...BOOT_MARKER, game_table: "gs-staging-game-copy" } }), /names gs-staging-game-copy/);
    assert.match(await gen({ marker: { ...BOOT_MARKER, restore_id: "x-restore" } }), /bootstrap marker names a restore/);
    assert.match(await gen({ appgen: null }), /no APPGEN/);
    assert.match(await gen({ appgen: new Error("APPGEN damaged") }), /APPGEN readable: unreadable/);
    assert.match(await gen({ appgen: { current_generation: 2, adoption: null } }), /APPGEN is 2, the marker 1/);
  });

  test("the APPGEN binding, never the number alone: a twin, another restore, an unadopted restore, an adopted bootstrap table -- each FAIL", async () => {
    const expect2 = { generation: 2, gameTable: "gs-staging-game-g2", requireRestore: false };
    assert.equal(await gen({ marker: RESTORED_MARKER, appgen: ADOPTED }, expect2), "", "the adopted copy serves");
    const twin = { ...RESTORED_MARKER, game_table: "gs-staging-game-g2b" };
    assert.match(await gen({ marker: twin, appgen: ADOPTED }, { ...expect2, gameTable: "gs-staging-game-g2b" }), /APPGEN adopted gs-staging-game-g2 .*not this table/);
    assert.match(await gen({ marker: { ...RESTORED_MARKER, restore_id: "drill-other" }, appgen: ADOPTED }, expect2), /restore drill-0930\), not this table/);
    assert.match(await gen({ marker: RESTORED_MARKER, appgen: { current_generation: 2, adoption: null } }, expect2), /never adopted/);
    assert.match(await gen({ marker: { ...BOOT_MARKER, generation: 2, game_table: "gs-staging-game-g2" }, appgen: ADOPTED }, expect2), /bootstrap table: not the adopted one/);
    assert.match(await gen({ marker: RESTORED_MARKER, appgen: { ...ADOPTED, adoption: { ...(ADOPTED.adoption as NonNullable<AppGenerationFacts["adoption"]>), previous_generation: 0 } } }, expect2), /previous generation 0 is not the marker's source generation 1/);
    assert.match(await gen({}, { ...expect1, requireRestore: true }), /a restore drill, but the serving table is a bootstrap table/);
  });

  test("identity restore state: only never-restored or target-complete, bound to its own name, is a usable identity deployment", async () => {
    assert.equal((await identity({})).failed, "");
    assert.equal((await identity({ restore: complete })).failed, "");
    assert.match((await identity({ restore: { ...complete, state: "replaying", completed_at: null } })).failed, /target replaying \/ incomplete .*never a healthy identity deployment/);
    assert.match((await identity({ restore: { ...complete, state: "superseded", peer_table: "gs-staging-identity-new" } })).failed, /source superseded by restore idr-0930 \(replaced by gs-staging-identity-new\)/);
    assert.match((await identity({ self: "gs-staging-identity-old" })).failed, /unreplayed copy/);
    assert.match((await identity({ restore: { ...complete, identity_table: "gs-staging-identity-old" } })).failed, /unreplayed copy/);
    assert.match((await identity({ self: null })).failed, /no TABLE#identity/);
    assert.match((await identity({ servingProblem: "the table names itself x" })).failed, /not serving-safe/);
    const { section } = await identity({ restore: complete });
    assert.ok(!JSON.stringify(section).includes("ab".repeat(32)), "the journal digest is not evidence");
  });

  test("REVIEW#: an open review is an unresolved finding, surfaced by restore and count only -- never a profile, principal or hash", async () => {
    const leaky = [{ restore_id: "idr-0930", reason: "unconfirmed-recovery-key-rotation", open: true, profile_id: "pf_secretish", principal_id: "p-123", selector: "rk_x" }, { restore_id: "idr-0930", reason: "unconfirmed-recovery-key-rotation", open: false }] as unknown as ReviewSummary[];
    const { section } = await identity({ reviews: leaky });
    const text = JSON.stringify(section);
    assert.ok(!/pf_secretish|p-123|rk_x/.test(text), text);
    const failed = failures(judgeReviews(section)).map((c) => c.detail).join("\n");
    assert.match(failed, /1 open REVIEW# record\(s\) -- an unresolved staging\/recovery finding: restore idr-0930: 1/);
    assert.deepEqual(failures(judgeReviews((await identity({ reviews: [{ restore_id: "idr-0930", reason: "x", open: false }] })).section)), []);
    assert.match(failures(judgeReviews((await identity({ reviews: new Error("SCAN refused") })).section)).map((c) => c.detail).join(), /unreadable/);
    const built = await buildPackage({ taskRole: await taskRoleRecord({ identity: { reviews: leaky } }) });
    try {
      assert.ok(failedGates((await verdictOf(built)).result).includes("review"));
    } finally {
      cleanup(built.dir);
    }
  });

  test("rollback: EVERY pool's automatic rollback target (its COMPLETED deployment) must run an attested L6-4 image", async () => {
    const built = await buildPackage();
    try {
      const ctx = await built.ctx();
      const runner = obj(obj(JSON.parse(fs.readFileSync(path.join(built.dir, EVIDENCE.taskRole), "utf8"))).runner);
      const expect = { environment: "staging", pools: ["p1"], primaryPool: "p1", primaryBuild: "2026-09-30-test", runningTaskDefinitions: { p1: TD }, running: ctx.prerequisite.running, runner };
      const failed = (e: Partial<typeof expect> = {}) => failures(judgeRollback(built.dir, { ...expect, ...e })).map((c) => `${c.name}: ${c.detail}`).join("\n");
      assert.equal(failed(), "", "the certified image serves p1 and is its rollback target");
      /* An ACTIVE earlier revision is NOT a candidate (skip_destroy keeps every revision ACTIVE; the circuit breaker never selects it). */
      const pre = { ...clone(TASK_DEFINITION.taskDefinition), taskDefinitionArn: TD.replace(":7", ":6"), containerDefinitions: [{ ...clone(TASK_DEFINITION.taskDefinition.containerDefinitions[0]), image: IMAGE.replace("2026-09-30-test", "2026-09-01-pre-l64") }] };
      write(built.dir, revisionsFile("p1"), { taskDefinitions: [TASK_DEFINITION.taskDefinition, pre] });
      assert.equal(failed(), "", "an unselectable ACTIVE revision is not treated as a rollback target");
      fs.rmSync(path.join(built.dir, revisionsFile("p1")));
      assert.equal(failed(), "", "the ACTIVE-revision list is informational");
      /* The capability report must be complete and the certifier task's own. */
      assert.match(failed({ runner: { ...runner, build_capabilities: { ...ALL_L64, identity_restore: false } } }), /the first AWS-mode image must contain L6-4/);
      assert.match(failed({ runner: { ...runner, task_arn: TASK } }), /not the certifier task's own/);
      assert.match(failed({ runner: { ...runner, build_id: "2026-09-30-other" } }), /BUILD_ID 2026-09-30-other is not the service's/);
      assert.match(failed({ runner: {} }), /certified image contains L6-4/);
      /* The capability report is the certifier task's, and that task ran the primary's RUNNING definition. */
      const run = clone(CERTIFIER_RUN);
      run.tasks[0].taskDefinitionArn = TD.replace(":7", ":6");
      write(built.dir, EVIDENCE.taskRoleRun, run);
      assert.match(failed(), /the certifier task ran .*gs-staging-p1:6, not the primary's running/);
      run.tasks[0].taskDefinitionArn = TD;
      run.tasks[0].containers = [{ name: "game-server", exitCode: 0 } as never];
      write(built.dir, EVIDENCE.taskRoleRun, run);
      assert.match(failed(), /ECS reports no image digest for the certifier task/);
    } finally {
      cleanup(built.dir);
    }
  });

  test("rollback, end to end: the primary's serving task on another digest than the certified one FAILS the certification", async () => {
    const built = await buildPackage({ mutate: { [EVIDENCE.runningTasks]: (v) => ((v.tasks[0].containers[0].imageDigest = `sha256:${"ee".repeat(32)}`), v) } });
    try {
      const { result } = await verdictOf(built);
      assert.deepEqual(failedGates(result), ["rollback"]);
      assert.match(gateFailures(result, "rollback").join("\n"), /p1 serves, and would roll back to, an L6-4 image: gs-staging-p1:7: .* @ sha256:eeee.* is not an attested L6-4 image/);
    } finally {
      cleanup(built.dir);
    }
  });

  test("rollback (L6-6R High): a NON-PRIMARY pool rolled back to (or serving) a pre-L6-4 image FAILS -- it was never checked before", async () => {
    const built = await buildPackage();
    try {
      const ctx = await built.ctx();
      const runner = obj(obj(JSON.parse(fs.readFileSync(path.join(built.dir, EVIDENCE.taskRole), "utf8"))).runner);
      const TD2 = "arn:aws:ecs:us-east-1:111111111111:task-definition/gs-staging-p2:3";
      const PRE_IMAGE = IMAGE.replace("2026-09-30-test", "2026-09-01-pre-l64");
      const PRE_DIGEST = `sha256:${"0e".repeat(32)}`;
      const services = clone(SERVICES) as any;
      services.services.push({ ...clone(SERVICES.services[0]), serviceName: "gs-staging-p2", taskDefinition: TD2, deployments: [{ status: "PRIMARY", taskDefinition: TD2, rolloutState: "COMPLETED" }] });
      write(built.dir, EVIDENCE_FILES.services, services);
      const td2 = { taskDefinition: { ...clone(TASK_DEFINITION.taskDefinition), taskDefinitionArn: TD2, family: "gs-staging-p2", containerDefinitions: [{ ...clone(TASK_DEFINITION.taskDefinition.containerDefinitions[0]), image: PRE_IMAGE, environment: [{ name: "BUILD_ID", value: "2026-09-30-test" }] }] } };
      write(built.dir, EVIDENCE_FILES.taskDefinition("p2"), td2);
      const p2task = { ...clone(RUNNING_TASKS.tasks[0]), taskArn: TASK.replace("0aaa", "0bbb"), group: "service:gs-staging-p2", taskDefinitionArn: TD2, containers: [{ name: "game-server", lastStatus: "RUNNING", imageDigest: PRE_DIGEST }] };
      const running = new Map([...ctx.prerequisite.running, ["p2", [p2task]]]);
      const expect: Parameters<typeof judgeRollback>[1] = { environment: "staging", pools: ["p1", "p2"], primaryPool: "p1", primaryBuild: "2026-09-30-test", runningTaskDefinitions: { p1: TD, p2: TD2 }, running, runner };
      const failed = (e: Partial<Parameters<typeof judgeRollback>[1]> = {}) => failures(judgeRollback(built.dir, { ...expect, ...e })).map((c) => `${c.name}: ${c.detail}`).join("\n");
      /* The BUILD_ID text is copied from the certified build: it attests nothing (the image does). */
      assert.match(failed(), /p2 serves, and would roll back to, an L6-4 image: gs-staging-p2:3: .*2026-09-01-pre-l64 @ sha256:0e0e.* is not an attested L6-4 image/);
      /* The same image reference but another digest (a re-pushed mutable tag): FAIL. */
      write(built.dir, EVIDENCE_FILES.taskDefinition("p2"), { taskDefinition: { ...td2.taskDefinition, containerDefinitions: [{ ...td2.taskDefinition.containerDefinitions[0], image: IMAGE }] } });
      assert.match(failed(), /gs-staging-p2:3: .* @ sha256:0e0e.* is not an attested/);
      /* The certified image and digest: PASS. */
      const same = new Map([...ctx.prerequisite.running, ["p2", [{ ...p2task, containers: [{ name: "game-server", lastStatus: "RUNNING", imageDigest: DIGEST }] }]]]);
      assert.equal(failed({ running: same }), "");
      /* A task that shows no digest cannot be established. */
      assert.match(failed({ running: new Map([...ctx.prerequisite.running, ["p2", [{ ...p2task, containers: [{ name: "game-server" }] }]]]) }), /a running task shows no image digest/);
      /* A pool at desired 0 (no running task): a TAG is not evidence of content -- even the certified tag -- only a digest pin. */
      assert.match(failed({ running: ctx.prerequisite.running }), /gs-staging-p2:3: .*2026-09-30-test \(no running task\) is not an attested L6-4 image -- a tag is not evidence of content/);
      const pin = (digest: string) => write(built.dir, EVIDENCE_FILES.taskDefinition("p2"), { taskDefinition: { ...td2.taskDefinition, containerDefinitions: [{ ...td2.taskDefinition.containerDefinitions[0], image: `111111111111.dkr.ecr.us-east-1.amazonaws.com/gs-staging-server@${digest}` }] } });
      pin(DIGEST);
      assert.equal(failed({ running: ctx.prerequisite.running }), "", "pinned to the certified digest");
      pin(PRE_DIGEST);
      assert.match(failed({ running: ctx.prerequisite.running }), /@sha256:0e0e.* \(no running task\) is not an attested/);
      write(built.dir, EVIDENCE_FILES.taskDefinition("p2"), td2);
      assert.match(failed({ running: ctx.prerequisite.running }), /2026-09-01-pre-l64 \(no running task\) is not an attested/);
      /* The target is ECS's COMPLETED deployment: a service with none cannot name its target; an uncaptured target FAILS. */
      const none = clone(services);
      none.services[1].deployments = [{ status: "PRIMARY", taskDefinition: TD2, rolloutState: "IN_PROGRESS" }];
      write(built.dir, EVIDENCE_FILES.services, none);
      assert.match(failed({ running: same }), /shows no COMPLETED deployment/);
      const older = clone(services);
      older.services[1].deployments = [{ status: "PRIMARY", taskDefinition: TD2, rolloutState: "IN_PROGRESS" }, { status: "ACTIVE", taskDefinition: TD2.replace(":3", ":2"), rolloutState: "COMPLETED" }];
      write(built.dir, EVIDENCE_FILES.services, older);
      assert.match(failed({ running: same }), /gs-staging-p2:2: its task definition was not captured/);
      services.services.pop();
      write(built.dir, EVIDENCE_FILES.services, services);
      assert.match(failed({ running: same }), /gs-staging-p2 is not in services.json/);
    } finally {
      cleanup(built.dir);
    }
  });

  test("rollback: a prior certification attests an image only if it is this environment's PASS, with L6-4 and that image's digest", async () => {
    const built = await buildPackage();
    try {
      const ctx = await built.ctx();
      const runner = obj(obj(JSON.parse(fs.readFileSync(path.join(built.dir, EVIDENCE.taskRole), "utf8"))).runner);
      const TD2 = "arn:aws:ecs:us-east-1:111111111111:task-definition/gs-staging-p2:3";
      const OLD = IMAGE.replace("2026-09-30-test", "2026-09-20-l64");
      const OLD_DIGEST = `sha256:${"a7".repeat(32)}`;
      const services = clone(SERVICES) as any;
      services.services.push({ ...clone(SERVICES.services[0]), serviceName: "gs-staging-p2", taskDefinition: TD2, deployments: [{ status: "PRIMARY", taskDefinition: TD2, rolloutState: "COMPLETED" }] });
      write(built.dir, EVIDENCE_FILES.services, services);
      write(built.dir, EVIDENCE_FILES.taskDefinition("p2"), { taskDefinition: { ...clone(TASK_DEFINITION.taskDefinition), taskDefinitionArn: TD2, containerDefinitions: [{ ...clone(TASK_DEFINITION.taskDefinition.containerDefinitions[0]), image: OLD }] } });
      const running = new Map([...ctx.prerequisite.running, ["p2", [{ ...clone(RUNNING_TASKS.tasks[0]), taskDefinitionArn: TD2, containers: [{ name: "game-server", imageDigest: OLD_DIGEST }] }]]]);
      const expect = { environment: "staging", pools: ["p1", "p2"], primaryPool: "p1", primaryBuild: "2026-09-30-test", runningTaskDefinitions: { p1: TD, p2: TD2 }, running, runner };
      const failed = () => failures(judgeRollback(built.dir, expect)).map((c) => c.detail).join("\n");
      const good = { format: CERTIFICATION_FORMAT, verdict: "PASS", failed_gates: [], environment: "staging", run_id: "l6cert-0920", build_id: "2026-09-20-l64", build_capabilities: ALL_L64, image: OLD, image_digest: OLD_DIGEST };
      const prior = (value: unknown) => write(built.dir, path.join(PRIOR_CERTIFICATIONS, "c1.json"), value);
      assert.match(failed(), /is not an attested L6-4 image/);
      prior(good);
      assert.equal(failed(), "", "an earlier PASS of this environment for exactly that image attests it");
      /* The old attestation shape (BUILD_ID text) attests nothing. */
      prior({ verdict: "PASS", build_id: "2026-09-20-l64", build_capabilities: ALL_L64 });
      assert.match(failed(), /prior certifications ignored: c1.json: not a certification, environment undefined, not staging, not a PASS, no certified image and digest/);
      for (const [mutation, why] of [
        [{ environment: "prod" }, /environment prod, not staging/],
        [{ verdict: "FAIL" }, /not a PASS/],
        [{ failed_gates: ["identity"] }, /not a PASS/],
        [{ build_capabilities: { ...ALL_L64, security_replay: false } }, /no L6-4 capability report/],
        [{ image_digest: `sha256:${"a8".repeat(32)}` }, /is not an attested/],
        [{ image: IMAGE.replace("2026-09-30-test", "2026-09-19") }, /is not an attested/],
        [{ image_digest: "latest" }, /no certified image and digest/],
        [{ format: "18COSMOS/L5-8-VERIFY/v1" }, /not a certification/],
      ] as const) {
        prior({ ...good, ...mutation });
        assert.match(failed(), why, JSON.stringify(mutation));
      }
      prior({ ...good, principal_id: "pr_x" });
      assert.match(failed(), /c1.json: .*player-identity field/, "a prior certification carrying identity material is refused, not read");
    } finally {
      cleanup(built.dir);
    }
  });

  test("the certification records the image and digest it certified (what a later run's rollback gate attests by)", async () => {
    const built = await buildPackage();
    try {
      const { ctx, result } = await verdictOf(built);
      writeCertification(ctx, result);
      const record = JSON.parse(fs.readFileSync(path.join(built.dir, EVIDENCE.certification), "utf8"));
      assert.equal(record.image, IMAGE);
      assert.equal(record.image_digest, DIGEST);
      assert.deepEqual(record.build_capabilities, ALL_L64);
      /* LIVE-6 final convergence: this build CONTAINS L6-4 (its own report says so) -- and binds its readers. */
      assert.deepEqual(buildCapabilities(), ALL_L64, "the converged build carries every L6-4 module");
    } finally {
      cleanup(built.dir);
    }
  });

  test("the restore drill: the stop before THIS adoption, for EVERY pool, nothing running or stopping (TASK# only as operator proof)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-l66-drill-"));
    try {
      const adoption = { ...(ADOPTED.adoption as NonNullable<AppGenerationFacts["adoption"]>), generation: 2 };
      const quiet = (e: Partial<Parameters<typeof judgeRestoreQuiet>[1]> = {}) => judgeRestoreQuiet(dir, { run: RUN, environment: "staging", pools: ["p1", "p2"], adoption, heartbeats: null, ...e });
      const failed = (e: Partial<Parameters<typeof judgeRestoreQuiet>[1]> = {}) => failures(quiet(e)).map((c) => `${c.name}: ${c.detail}`).join("\n");
      const svc = (pool: string, desired = 0, runningCount = 0) => ({ serviceName: `gs-staging-${pool}`, status: "ACTIVE", desiredCount: desired, runningCount, pendingCount: 0 });
      const listing = (tasks: unknown[], failures: unknown[] = []) => ({ batches: [{ tasks, failures }] });
      write(dir, path.join(RESTORE_STOP_DIR, "services.json"), { services: [svc("p1"), svc("p2")], failures: [] });
      write(dir, path.join(RESTORE_STOP_DIR, "cluster-tasks.json"), listing([{ taskArn: "arn:x/task/gs-staging/old1", lastStatus: "STOPPED", desiredStatus: "STOPPED" }]));
      const stamp = { format: RESTORE_STOP_FORMAT, run_id: RUN, restore_id: "drill-0930", captured_at: "2026-09-30T09:30:00Z" };
      write(dir, path.join(RESTORE_STOP_DIR, "stamp.json"), stamp);
      assert.equal(failed(), "");
      assert.match(quiet().map((c) => c.detail).join(), /not integrated \(L6-5A\): the stop is proven from ECS alone/);
      /* TASK#: a fresh old-generation heartbeat is operator evidence of a straggler; an absent list is not "none". */
      assert.match(failed({ heartbeats: { integrated: true, oldGenerationAfterStop: ["t-old1"] } }), /fresh heartbeats from t-old1/);
      assert.match(failed({ heartbeats: { integrated: true, oldGenerationAfterStop: undefined as never } }), /not a list/);
      assert.equal(failed({ heartbeats: { integrated: true, oldGenerationAfterStop: [] } }), "", "no heartbeat: the ECS stop stands (TASK# is never the authority)");
      /* Bound to this adoption: its restore id, before adopted_at, and not long before. */
      assert.match(failed({ adoption: { ...adoption, adopted_at: Date.parse("2026-09-30T09:00:00Z") } }), /captured after APPGEN moved/);
      assert.match(failed({ adoption: { ...adoption, adopted_at: Date.parse("2026-09-30T16:00:00Z") } }), /more than 6 h before the adoption/);
      assert.match(failed({ adoption: { ...adoption, restore_id: "drill-other" } }), /restore drill-0930 \(this run .*APPGEN adopted restore drill-other\)/);
      assert.match(failed({ adoption: null }), /APPGEN shows no adoption/);
      write(dir, path.join(RESTORE_STOP_DIR, "stamp.json"), { ...stamp, run_id: "l6cert-other" });
      assert.match(failed(), /run l6cert-other/);
      write(dir, path.join(RESTORE_STOP_DIR, "stamp.json"), { format: "18COSMOS/L6-6-RESTORE-STOP/v1", run_id: RUN, captured_at: stamp.captured_at });
      assert.match(failed(), /RESTORE-STOP\/v1 run .* restore undefined/, "a stop that names no restore");
      write(dir, path.join(RESTORE_STOP_DIR, "stamp.json"), { ...stamp, format: "18COSMOS/L6-6-RESTORE-STOP/v1" });
      assert.match(failed(), /RESTORE-STOP\/v1 run .* restore drill-0930/, "an old-format stop (its listing omits draining tasks) is not accepted");
      write(dir, path.join(RESTORE_STOP_DIR, "stamp.json"), stamp);
      /* Every pool present and at zero. */
      write(dir, path.join(RESTORE_STOP_DIR, "services.json"), { services: [svc("p1")], failures: [] });
      assert.match(failed(), /not in the stop evidence as exactly one ACTIVE service: p2/);
      write(dir, path.join(RESTORE_STOP_DIR, "services.json"), { services: [svc("p1"), { ...svc("p2"), status: "INACTIVE" }], failures: [] });
      assert.match(failed(), /exactly one ACTIVE service: p2/, "a stale INACTIVE record is not the pool's service");
      write(dir, path.join(RESTORE_STOP_DIR, "services.json"), { services: [svc("p1"), svc("p2"), svc("p2")], failures: [] });
      assert.match(failed(), /exactly one ACTIVE service: p2/);
      write(dir, path.join(RESTORE_STOP_DIR, "services.json"), { services: [svc("p1"), svc("p2", 0, 1)], failures: [] });
      assert.match(failed(), /not stopped: gs-staging-p2/);
      write(dir, path.join(RESTORE_STOP_DIR, "services.json"), { services: [svc("p1"), svc("p2")], failures: [{ arn: "gs-staging-p3", reason: "MISSING" }] });
      assert.match(failed(), /the service listing is incomplete/);
      write(dir, path.join(RESTORE_STOP_DIR, "services.json"), { services: [svc("p1"), svc("p2")], failures: [] });
      /* A task still draining (desired STOPPED, last status RUNNING) is still running. */
      write(dir, path.join(RESTORE_STOP_DIR, "cluster-tasks.json"), listing([{ taskArn: "arn:x/task/gs-staging/draining", lastStatus: "DEACTIVATING", desiredStatus: "STOPPED" }]));
      assert.match(failed(), /still running or stopping: draining/);
      write(dir, path.join(RESTORE_STOP_DIR, "cluster-tasks.json"), listing([{ taskArn: `arn:x/task/gs-staging/${"4c".repeat(16)}`, lastStatus: "STOPPING", desiredStatus: "STOPPED" }]));
      assert.match(failed(), new RegExp(`still running or stopping: ${"4c".repeat(16)}`), "an ECS task id is named, never redacted");
      write(dir, path.join(RESTORE_STOP_DIR, "cluster-tasks.json"), { batches: [{ tasks: [{ taskArn: "arn:x/task/gs-staging/a", lastStatus: "STOPPED" }], failures: [] }, { tasks: [{ taskArn: "arn:x/task/gs-staging/straggler", lastStatus: "RUNNING" }], failures: [] }] });
      assert.match(failed(), /still running or stopping: straggler/, "every batch is read");
      write(dir, path.join(RESTORE_STOP_DIR, "cluster-tasks.json"), { batches: [{ tasks: [], failures: [] }, { tasks: [], failures: [{ arn: "arn:x/task/gs-staging/gone", reason: "MISSING" }] }] });
      assert.match(failed(), /the task listing is incomplete/);
      write(dir, path.join(RESTORE_STOP_DIR, "cluster-tasks.json"), { batches: [{ failures: [] }] });
      assert.match(failed(), /the task listing is incomplete/);
      write(dir, path.join(RESTORE_STOP_DIR, "cluster-tasks.json"), { tasks: [], failures: [] });
      assert.match(failed(), /the task listing is incomplete/, "a single unbatched answer is the old listing (desired RUNNING only)");
      write(dir, path.join(RESTORE_STOP_DIR, "cluster-tasks.json"), { batches: [] });
      assert.equal(failed(), "", "nothing listed at all: nothing runs");
    } finally {
      cleanup(dir);
    }
  });

  test("the restore fence: bound to THIS adoption, one structured GENERATION-fencing result per case -- a probe missing or a generic exit FAILS", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-l66-fence-"));
    try {
      const adoption = { ...(ADOPTED.adoption as NonNullable<AppGenerationFacts["adoption"]>), generation: 2 };
      const after = "2026-09-30T09:45:00Z";
      const cases = {
        "old-generation-ledger-write-refused": { observed_at: after, generation: 1, outcome: "fenced", fence: "generation", detail: "reserveSettlement: fenced (generation)" },
        "old-generation-task-never-ready": { observed_at: after, generation: 1, ready: false, exit_code: 2, reason: "generation", detail: "refused: adopted app generation is 2" },
        "kms-side-effect-withheld": { observed_at: after, generation: 1, kms_sign_calls: 0, outcome: "withheld", detail: "gatedKmsClient: unavailable" },
        "new-generation-started": { observed_at: after, generation: 2, game_table: "gs-staging-game-g2", ready: true, detail: "readyz 200" },
      };
      const record = { format: RESTORE_FENCING_FORMAT, run_id: RUN, adoption: { restore_id: adoption.restore_id, game_table: adoption.game_table, previous_generation: 1, generation: 2, adopted_at: adoption.adopted_at }, cases };
      const failed = (value: unknown, a: typeof adoption | null = adoption) => {
        write(dir, RESTORE_FENCING_FILE, value);
        return failures(judgeRestoreFencing(dir, { run: RUN, adoption: a })).map((c) => `${c.name}: ${c.detail}`).join("\n");
      };
      assert.equal(failed(record), "");
      const withCase = (name: keyof typeof cases, change: Record<string, unknown>) => ({ ...record, cases: { ...cases, [name]: { ...cases[name], ...change } } });
      assert.match(failed(withCase("old-generation-task-never-ready", { exit_code: 1, reason: "crash" })), /a process exit is not generation fencing/);
      assert.match(failed(withCase("old-generation-task-never-ready", { exit_code: 3, reason: "pool-lost" })), /a process exit is not generation fencing/);
      assert.match(failed(withCase("old-generation-task-never-ready", { exit_code: 1, reason: "generation" })), /a process exit is not generation fencing/);
      assert.match(failed(withCase("old-generation-task-never-ready", { ready: true })), /a process exit is not generation fencing/);
      assert.equal(failed(withCase("old-generation-task-never-ready", { exit_code: 3 })), "", "lost on the self-check (exit 3) because the generation moved");
      assert.match(failed(withCase("old-generation-ledger-write-refused", { fence: "relayer" })), /not a write of the old generation refused by the generation fence/);
      assert.match(failed(withCase("old-generation-ledger-write-refused", { generation: 2 })), /not a write of the old generation/);
      assert.match(failed(withCase("kms-side-effect-withheld", { kms_sign_calls: 1 })), /not withheld before KMS/);
      assert.match(failed(withCase("new-generation-started", { game_table: "gs-staging-game-g2b" })), /not the adopted generation 2 on gs-staging-game-g2/);
      assert.match(failed(withCase("new-generation-started", { observed_at: "2026-09-30T09:39:00Z" })), /not after this adoption/);
      assert.match(failed({ ...record, cases: { ...cases, "kms-side-effect-withheld": undefined } }), /kms-side-effect-withheld: NOT proven: no evidence recorded \(probe missing\)/);
      assert.match(failed({ ...record, cases: Object.fromEntries(Object.keys(cases).map((k) => [k, { observed: true, detail: "observed" }])) }), /NOT proven/, "the old bare `observed: true` proves nothing");
      assert.match(failed({ ...record, adoption: { ...record.adoption, restore_id: "drill-other" } }), /this run, this adoption/);
      assert.match(failed({ ...record, adoption: { ...record.adoption, adopted_at: adoption.adopted_at - 1 } }), /this run, this adoption/);
      assert.match(failed({ ...record, run_id: "l6cert-other" }), /this run, this adoption/);
      assert.match(failed(record, null), /APPGEN shows no adoption/);
      fs.rmSync(path.join(dir, RESTORE_FENCING_FILE));
      assert.match(failures(judgeRestoreFencing(dir, { run: RUN, adoption })).map((c) => c.detail).join(), /no destructive or chain-affecting probe is part of this slice/);
    } finally {
      cleanup(dir);
    }
    const built = await buildPackage();
    try {
      const { result } = await verdictOf(built, { scenario: "restore-drill" });
      for (const gate of ["restore-quiet", "restore-fence", "generation"]) assert.ok(failedGates(result).includes(gate), `${gate}: ${JSON.stringify(failedGates(result))}`);
      const readOnly = (await verdictOf(built)).result;
      assert.equal(readOnly.gates.find((g) => g.id === "restore-quiet")?.status, "not-required");
      const standalone = (await verdictOf(built, { scenario: "restore-drill", generationEvidence: { integrated: false, marker: null, appgen: null, startupRule: null } })).result;
      for (const gate of ["restore-quiet", "restore-fence"]) assert.match(gateFailures(standalone, gate).join("\n"), /not bound in this build/, gate);
    } finally {
      cleanup(built.dir);
    }
  });

  test("the restore drill CAN pass once integrated: generation 2 adopted, every gate PASS end to end -- and each drill binding is load-bearing", async () => {
    const built = await buildPackage({ generation: { marker: RESTORED_MARKER, appgen: ADOPTED } });
    try {
      const adoption = ADOPTED.adoption as NonNullable<AppGenerationFacts["adoption"]>;
      write(built.dir, path.join(RESTORE_STOP_DIR, "services.json"), { services: [{ serviceName: "gs-staging-p1", status: "ACTIVE", desiredCount: 0, runningCount: 0, pendingCount: 0 }], failures: [] });
      write(built.dir, path.join(RESTORE_STOP_DIR, "cluster-tasks.json"), { batches: [{ tasks: [], failures: [] }] });
      write(built.dir, path.join(RESTORE_STOP_DIR, "stamp.json"), { format: RESTORE_STOP_FORMAT, run_id: RUN, restore_id: adoption.restore_id, captured_at: "2026-09-30T09:30:00Z" });
      const at = "2026-09-30T09:45:00Z";
      write(built.dir, RESTORE_FENCING_FILE, {
        format: RESTORE_FENCING_FORMAT,
        run_id: RUN,
        adoption: { restore_id: adoption.restore_id, game_table: adoption.game_table, previous_generation: 1, generation: 2, adopted_at: adoption.adopted_at },
        cases: {
          "old-generation-ledger-write-refused": { observed_at: at, generation: 1, outcome: "fenced", fence: "generation" },
          "old-generation-task-never-ready": { observed_at: at, generation: 1, ready: false, exit_code: 2, reason: "generation" },
          "kms-side-effect-withheld": { observed_at: at, generation: 1, kms_sign_calls: 0, outcome: "withheld" },
          "new-generation-started": { observed_at: at, generation: 2, game_table: "gs-staging-game-g2", ready: true },
        },
      });
      /* LIVE-6 final convergence: the generation gate's own record, the plan's generation_adoption, the restore alarms. */
      writeDrillEvidence(built.dir, "restore");
      const base = await built.ctx();
      const startup = { ...base.prerequisite.startup, config: { ...base.prerequisite.startup.config, generation: 2, gameTable: "gs-staging-game-g2" } };
      /* The switch came after the generation gate (09:50): the task serving g2 started after it. */
      const running = new Map([["p1", (base.prerequisite.running.get("p1") ?? []).map((t) => ({ ...t, startedAt: "2026-09-30T09:55:00.000Z" }))]]);
      const result = certify({ ...base, scenario: "restore-drill", prerequisite: { ...base.prerequisite, startup, running } });
      assert.deepEqual(failedGates(result), [], JSON.stringify(result.gates.map((g) => [g.id, failures(g.checks)])));
      assert.equal(result.gates.find((g) => g.id === "restore-quiet")?.status, "pass");
      assert.equal(result.gates.find((g) => g.id === "restore-fence")?.status, "pass");
      const early = certify({ ...base, scenario: "restore-drill", prerequisite: { ...base.prerequisite, startup } });
      assert.deepEqual(failedGates(early), ["generation-gate"], "a task started before the gate (09:00 < 09:50): the attestation was not the switch's");
      assert.match(JSON.stringify(early.gates.find((g) => g.id === "generation-gate")), /the switch came after the gate/);
      const otherRestore = { ...base, scenario: "restore-drill" as const, prerequisite: { ...base.prerequisite, startup, running }, generationEvidence: await generationOf({ marker: { ...RESTORED_MARKER, restore_id: "drill-other" }, appgen: { ...ADOPTED, adoption: { ...adoption, restore_id: "drill-other" } } }) };
      assert.deepEqual(failedGates(certify(otherRestore)), ["restore-quiet", "restore-fence", "generation-gate"], "the drill's evidence is bound to ITS adoption");
    } finally {
      cleanup(built.dir);
    }
  });
});

/* ------------------------------------------------------------------ */
/* L6-6R: the independent recovery-gate review's adversarial cases      */
/* ------------------------------------------------------------------ */

describe("L6-6R: the recovery gates, attacked", () => {
  const { judgeGeneration, judgeIdentityRecovery, judgeReviews, identityRestoreState, restoreSafe } = require("./recovery") as typeof import("./recovery");
  const expect1 = { generation: 1, gameTable: "gs-staging-game-g1", requireRestore: false };
  const expect2 = { generation: 2, gameTable: "gs-staging-game-g2", requireRestore: false };
  const gen = async (script: ReaderScript, expect = expect1) => failures(judgeGeneration(await generationOf(script), expect)).map((c) => `${c.name}: ${c.detail}`).join("\n");
  const identity = async (script: ReaderScript) => {
    const section = await readIdentityRecovery(readersFor(script), {} as never, IDENTITY_TABLE);
    return { section, text: JSON.stringify(section), failed: failures(judgeIdentityRecovery(section, IDENTITY_TABLE)).map((c) => `${c.name}: ${c.detail}`).join("\n"), reviews: failures(judgeReviews(section)).map((c) => c.detail).join("\n") };
  };
  const complete: IdentityRestoreFacts = { restore_id: "idr-0930", state: "complete", identity_table: IDENTITY_TABLE, peer_table: "gs-staging-identity-old", restore_point: 5, started_at: 6, journal_digest: "ab".repeat(32), journal_events: 12, completed_at: 7, reviews: 0 };
  const PF = "pf_0123456789abcdefghjkmnpqrs";
  const EVENT = "0f".repeat(16);

  test("generation: the full matrix -- only the exact serving-safe state passes", async () => {
    const adoptedTo = (over: Partial<NonNullable<AppGenerationFacts["adoption"]>>, current = 2): AppGenerationFacts => ({ current_generation: current, adoption: { ...(ADOPTED.adoption as NonNullable<AppGenerationFacts["adoption"]>), ...over } });
    const cases: Array<[string, ReaderScript, typeof expect1, RegExp | null]> = [
      ["bootstrap marker, bootstrap APPGEN", {}, expect1, null],
      ["correct adopted restore", { marker: RESTORED_MARKER, appgen: ADOPTED }, expect2, null],
      ["absent marker", { marker: null }, expect1, /carries no SYSTEM\/GENERATION/],
      ["malformed marker (L6-4's parser throws)", { marker: new Error("the game table's SYSTEM/GENERATION is damaged") }, expect1, /unreadable/],
      ["newer marker (L6-4's parser throws)", { marker: new Error("SYSTEM/GENERATION is format 2, written by a newer build") }, expect1, /unreadable .*newer build/],
      ["bootstrap marker after APPGEN adoption", { appgen: adoptedTo({ game_table: "gs-staging-game-g1" }, 1) }, expect1, /bootstrap table: not the adopted one/],
      ["prepared restore, not adopted", { marker: RESTORED_MARKER, appgen: { current_generation: 1, adoption: null } }, expect2, /APPGEN is 1, the marker 2|never adopted/],
      ["prepared restore, APPGEN at 2 but bootstrap form", { marker: RESTORED_MARKER, appgen: { current_generation: 2, adoption: null } }, expect2, /never adopted/],
      ["wrong table", { marker: { ...RESTORED_MARKER, game_table: "gs-staging-game-g2x" }, appgen: ADOPTED }, expect2, /names gs-staging-game-g2x/],
      ["twin prepared as the same generation", { marker: { ...RESTORED_MARKER, game_table: "gs-staging-game-g2b" }, appgen: ADOPTED }, { ...expect2, gameTable: "gs-staging-game-g2b" }, /APPGEN adopted gs-staging-game-g2 .*not this table/],
      ["wrong restore id", { marker: RESTORED_MARKER, appgen: adoptedTo({ restore_id: "drill-other" }) }, expect2, /restore drill-other\), not this table/],
      ["wrong previous generation", { marker: { ...RESTORED_MARKER, generation: 3, restored_from_generation: 1 }, appgen: adoptedTo({ previous_generation: 2 }, 3) }, { ...expect2, generation: 3 }, /previous generation 2 is not the marker's source generation 1/],
      ["runtime generation mismatch", { marker: RESTORED_MARKER, appgen: ADOPTED }, { ...expect2, generation: 3 }, /runtime document says 3/],
      ["APPGEN matches numerically, the adoption names another table", { marker: RESTORED_MARKER, appgen: adoptedTo({ game_table: "gs-staging-game-g2c" }) }, expect2, /APPGEN adopted gs-staging-game-g2c/],
      ["APPGEN absent", { appgen: null }, expect1, /no APPGEN/],
      ["APPGEN unreadable", { appgen: new Error("APPGEN schema 2") }, expect1, /APPGEN readable: unreadable/],
      ["a restore marker naming itself as its source", { marker: { ...RESTORED_MARKER, restored_from_table: "gs-staging-game-g2" }, appgen: ADOPTED }, expect2, /naming itself/],
      ["a restore marker not above its source", { marker: { ...RESTORED_MARKER, restored_from_generation: 2 }, appgen: adoptedTo({ previous_generation: 2 }) }, expect2, /source generation is not below its own/],
    ];
    for (const [label, script, expect, want] of cases) {
      const got = await gen(script, expect);
      if (want === null) assert.equal(got, "", label);
      else assert.match(got, want, label);
    }
  });

  test("generation: L6-4's own startup rule is required too -- it can veto a composed PASS, and its silence never replaces the composition", async () => {
    assert.match(await gen({ startup: "the ledger's APPGEN adopted x (restore r), not this table" }), /L6-4's own startup rule accepts this table: L6-4 refuses the start: the ledger's APPGEN adopted x/);
    assert.match(await gen({ startup: new Error("boom") }), /L6-4's own startup rule accepts this table: unreadable \(Error: boom\)/);
    const nonString = (await generationOf({})) as import("./recovery").GenerationEvidence;
    const weird = { ...nonString, startupRule: () => ({ ok: true as const, value: undefined as unknown as null }) };
    assert.equal(failures(judgeGeneration(weird, expect1)).length, 1, "`undefined` is not L6-4's null");
    const liar = readersFor({ marker: { ...RESTORED_MARKER, game_table: "gs-staging-game-g2b" }, appgen: ADOPTED });
    const evidence = await readGenerationEvidence({ ...liar, generationServingProblem: () => 0 as unknown as null }, { app: {} as never, ledger: {} as never }, { game: "g", ledger: "l" });
    assert.match(failures(judgeGeneration(evidence, { ...expect2, gameTable: "gs-staging-game-g2b" })).map((c) => c.detail).join("\n"), /answered number[\s\S]*not this table/, "a reader that says nothing wrong still fails the composed binding");
    assert.match(await gen({ startup: `refused for ${PF}` }), /refused for <redacted>/, "reader text is made restore-safe");
  });

  test("identity: never-restored, copied, replaying, incomplete, complete, superseded, disagreeing, malformed, unreadable -- fail closed", async () => {
    const cases: Array<[string, ReaderScript, RegExp | null]> = [
      ["never-restored serving table", {}, null],
      ["completed target", { restore: complete }, null],
      ["copied table carrying another TABLE#identity", { self: "gs-staging-identity-old" }, /unreplayed copy[\s\S]*TABLE#identity names gs-staging-identity-old/],
      ["copy carrying another table's complete marker", { restore: { ...complete, identity_table: "gs-staging-identity-old" } }, /unreplayed copy/],
      ["replaying target", { restore: { ...complete, state: "replaying", completed_at: null, reviews: null } }, /target replaying \/ incomplete/],
      ["complete marker but TABLE#identity not yet renamed", { restore: complete, self: "gs-staging-identity-old" }, /unreplayed copy/],
      ["superseded source", { restore: { ...complete, state: "superseded", peer_table: "gs-staging-identity-new" } }, /source superseded/],
      ["marker/table-name agree, L6-4 disagrees", { restore: complete, servingProblem: "the table is a restored copy whose replay has not completed" }, /not serving-safe: the table is a restored copy/],
      ["malformed restore state", { restore: { ...complete, state: "bogus" as never } }, /malformed/],
      ["no TABLE#identity", { self: null }, /no TABLE#identity/],
    ];
    for (const [label, script, want] of cases) {
      const { failed, text } = await identity(script);
      if (want === null) assert.equal(failed, "", label);
      else {
        assert.match(failed, want, label);
        assert.ok(!/usable|serving-safe restore state -- (never restored|target complete)/.test(failed), `${label}: an unsafe target is never described as usable`);
      }
      assert.ok(!text.includes("ab".repeat(32)), `${label}: no journal digest`);
    }
    assert.equal(identityRestoreState({ ...complete, state: "bogus" as never }, IDENTITY_TABLE, IDENTITY_TABLE), "malformed");
    assert.equal(identityRestoreState(complete, 7 as never, IDENTITY_TABLE), "malformed");
    /* A reader error / unavailable: unreadable, FAIL, and its text restore-safe. */
    const broken: RecoveryReaders = { ...readersFor(), identityState: async () => Promise.reject(new Error(`ResourceNotFound while reading ${PF}`)) };
    const section = await readIdentityRecovery(broken, {} as never, IDENTITY_TABLE);
    assert.match(failures(judgeIdentityRecovery(section, IDENTITY_TABLE)).map((c) => c.detail).join(), /unreadable \(Error: ResourceNotFound while reading <redacted>\)/);
    assert.ok(!JSON.stringify(section).includes(PF));
    /* A binding bug (a Promise, undefined) is never L6-4's "no problem". */
    for (const servingProblem of [undefined, Promise.resolve(null), 0]) {
      const r: RecoveryReaders = { ...readersFor(), identityState: async () => ({ restore: null, self: IDENTITY_TABLE, servingProblem: servingProblem as never }) };
      const s = await readIdentityRecovery(r, {} as never, IDENTITY_TABLE);
      assert.ok(failures(judgeIdentityRecovery(s, IDENTITY_TABLE)).length > 0, String(servingProblem));
    }
    /* Intentionally leaky reader output: ids in structured or free fields never reach the evidence. */
    const leak = await identity({ restore: { ...complete, restore_id: EVENT }, servingProblem: `profile ${PF} event ${EVENT}` });
    assert.ok(!leak.text.includes(PF) && !leak.text.includes(EVENT), leak.text);
    assert.match(leak.failed, /malformed|not serving-safe/);
    const idOnly = await identity({ restore: { ...complete, restore_id: PF } });
    assert.match(idOnly.failed, /malformed/, "a restore id that is no restore id (a profile id) makes the state malformed, even when L6-4 says nothing");
    assert.ok(!idOnly.text.includes(PF));
    const badSelf = await identity({ self: `REVIEW#${PF}` });
    assert.match(badSelf.failed, /restore state is not one this build names \(malformed\)/, "a table binding that is no table name");
    assert.ok(!badSelf.text.includes(PF), badSelf.text);
    /* No false FAIL: an L6-4-valid restore id that happens to carry a git sha serves (it is only redacted where printed). */
    const sha = `drill-${"5a".repeat(20)}`;
    const shaRun = await identity({ restore: { ...complete, restore_id: sha }, reviews: [{ restore_id: sha, reason: "unconfirmed-recovery-key-rotation", open: false }] });
    assert.equal(shaRun.failed, "");
    assert.equal(shaRun.reviews, "");
    const shaOpen = await identity({ restore: { ...complete, restore_id: sha }, reviews: [{ restore_id: sha, reason: "unconfirmed-recovery-key-rotation", open: true }] });
    assert.match(shaOpen.reviews, /1 open REVIEW# record\(s\).*restore drill-<redacted>: 1/, "counted; a hex run is never printed (it could be an event id or a hash)");
    assert.ok(!shaOpen.text.includes("5a".repeat(20)));
  });

  test("REVIEW#: zero passes, one or many open fail, resolved does not count, malformed fails, leaky output never leaks", async () => {
    const review = (open: boolean, restore = "idr-0930") => ({ restore_id: restore, reason: "unconfirmed-recovery-key-rotation", open });
    assert.equal((await identity({ reviews: [] })).reviews, "");
    assert.equal((await identity({ reviews: [review(false), review(false, "idr-0801")] })).reviews, "", "resolved reviews are not open");
    assert.match((await identity({ reviews: [review(true)] })).reviews, /1 open REVIEW# record\(s\).*restore idr-0930: 1/);
    assert.match((await identity({ reviews: [review(true), review(true), review(true, "idr-0801"), review(false)] })).reviews, /3 open REVIEW# record\(s\).*restore idr-0930: 2, restore idr-0801: 1/);
    for (const [label, bad] of [
      ["open missing", { restore_id: "idr-0930", reason: "unconfirmed-recovery-key-rotation" }],
      ["open as a string", { ...review(false), open: "false" }],
      ["open as a number", { ...review(false), open: 0 }],
      ["restore id is a profile id", { ...review(false), restore_id: PF }],
      ["restore id is a session id", { ...review(false), restore_id: "se_0123456789abcdefghjkmnpqrs" }],
      ["reason carries a principal", { ...review(false), reason: "pr_0123456789abcdefghjkmnpqrs" }],
      ["reason carries a hash", { ...review(false), reason: "ab".repeat(32) }],
      ["not an object", "REVIEW#pf_x"],
    ] as const) {
      const { reviews, text } = await identity({ reviews: [review(false), bad as never] });
      assert.match(reviews, /REVIEW# summaries malformed: .*never counted as resolved/, label);
      assert.ok(!text.includes(PF) && !text.includes(EVENT) && !text.includes("ab".repeat(32)) && !text.includes("pr_0123"), `${label}: ${text}`);
    }
    assert.match((await identity({ reviews: { length: 0 } as never })).reviews, /not a list/);
    assert.match((await identity({ reviews: new Error(`Scan refused on REVIEW#${PF}`) })).reviews, /unreadable \(Error: Scan refused on REVIEW#<redacted>\)/);
    const leaky = [{ ...review(true), profile_id: PF, principal_id: "pr_0123456789abcdefghjkmnpqrs", selector: "rk_0123456789abcdefghjkmnpqrs", unconfirmed_events: `["${EVENT}"]`, hash: "cd".repeat(32) }] as unknown as ReviewSummary[];
    const { text, reviews } = await identity({ reviews: leaky });
    assert.ok(!/pf_|pr_|rk_|0f0f0f0f|cdcdcdcd/.test(text), text);
    assert.match(reviews, /1 open/);
  });

  test("restoreSafe redacts every id shape and nothing else", () => {
    assert.equal(restoreSafe(`a ${PF} b se_0123456789abcdefghjkmnpqrs sf_0123456789abcdefghjkmnpqrs rk_0123456789abcdefghjkmnpqrs ${EVENT} ${"ab".repeat(32)} c`), "a <redacted> b <redacted> <redacted> <redacted> <redacted> <redacted> c");
    assert.equal(restoreSafe("gs-staging-identity restore drill-0930 generation 2"), "gs-staging-identity restore drill-0930 generation 2");
    assert.equal(restoreSafe(`x_${PF} ev_${EVENT} ${EVENT}g`), "x_<redacted> ev_<redacted> <redacted>g", "glued to word characters");
    /* Redacted before it is cut: an id straddling the cut never leaks in part. */
    const long = `${"x".repeat(190)} ${PF} tail`;
    const cut = readIdentityRecovery({ ...readersFor(), identityState: async () => Promise.reject(new Error(long)) }, {} as never, IDENTITY_TABLE);
    return cut.then((section) => assert.ok(!/pf_[0-9a-z]{3,}/.test(JSON.stringify(section)), JSON.stringify(section)));
  });
});

describe("L6-6R: the integration binding is explicit, and no default or fixture path can pass the recovery gates", () => {
  const SRC = path.join(REPO, "server/src");
  const sources = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [path.join(dir, e.name)] : []));
  const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

  test("RecoveryReaders is bound in exactly one production place, to L6-4's own functions -- and on this branch, nowhere", () => {
    const binders = sources(SRC).filter((f) => /\brecovery\s*:/.test(fs.readFileSync(f, "utf8")) && /StagingDeps/.test(fs.readFileSync(f, "utf8")));
    for (const f of binders) {
      assert.equal(rel(f) === "tools/awsDeploy.ts" || rel(f) === "aws/deploy/staging/commands.ts", true, `${rel(f)} binds the recovery readers`);
    }
    const tool = fs.readFileSync(path.join(SRC, "tools/awsDeploy.ts"), "utf8");
    const binding = /\brecovery\s*:\s*[^,}]/.test(tool);
    if (binding) {
      /* The integration: every member names L6-4's function (never a local re-implementation). */
      for (const fn of ["readGenerationMarker", "readAppGeneration", "generationMarkerProblem", "adoptionBindingProblem", "readIdentityRestore", "identityServingProblem", "inspectIdentityRestore"]) assert.match(tool, new RegExp(`\\b${fn}\\b`), fn);
    } else {
      assert.ok(Object.values(buildCapabilities()).some((v) => v === false), "standalone: no binding, and the build does not carry L6-4");
    }
  });

  test("an integrated GenerationEvidence is constructed only by readGenerationEvidence; the gates read it only from the command's live read", () => {
    for (const f of sources(SRC)) {
      const text = fs.readFileSync(f, "utf8");
      if (rel(f) !== "aws/deploy/staging/recovery.ts") {
        assert.ok(!/integrated:\s*true/.test(text), `${rel(f)} fabricates an integrated reading`);
        assert.ok(!/startupRule\s*:/.test(text), `${rel(f)} fabricates L6-4's rule`);
      }
      if (/readGenerationEvidence\(|readIdentityRecovery\(/.test(text) && rel(f) !== "aws/deploy/staging/recovery.ts") {
        assert.equal(rel(f), "aws/deploy/staging/commands.ts", `${rel(f)} reads the recovery evidence`);
        for (const call of text.match(/read(GenerationEvidence|IdentityRecovery)\(([^,]+),/g) ?? []) assert.match(call, /\(staging\.recovery,/, call);
      }
    }
  });

  test("end to end through the commands: an unbound build's certification FAILS every recovery gate, whatever the evidence says", async () => {
    const built = await buildPackage();
    try {
      /* Even with a perfect task-role record (a forged 'ran' identity section), the unbound live generation read fails. */
      const unbound = await readGenerationEvidence(undefined, { app: {} as never, ledger: {} as never }, { game: "g", ledger: "l" });
      assert.deepEqual(unbound, { integrated: false, marker: null, appgen: null, startupRule: null });
      const { result } = await verdictOf(built, { generationEvidence: unbound });
      assert.ok(failedGates(result).includes("generation"));
      assert.equal(result.passed, false);
      assert.match(JSON.stringify(await readIdentityRecovery(undefined, {} as never, IDENTITY_TABLE)), /not-integrated/);
    } finally {
      cleanup(built.dir);
    }
  });
});

/* ------------------------------------------------------------------ */
/* L6-6P: the prerequisite's COMPLETE cluster listing                   */
/* ------------------------------------------------------------------ */

describe("L6-6P: the prerequisite's cluster listing is complete -- every page, desired RUNNING and STOPPED, every batch", () => {
  const PREREQ = { environment: "staging", pools: ["p1"], primaryPool: "p1" };
  const CAPTURE = { format: "18COSMOS/L5-8-CAPTURE/v1", captured_at: TIMES.capture };
  const SETTLED = RUNNING_TASKS.tasks[0] as Record<string, unknown>;
  const liveArn = (i: number) => `arn:aws:ecs:us-east-1:111111111111:task/gs-staging/${(0xf000 + i).toString(16).padStart(32, "a")}`;
  const STRAY = { ...SETTLED, taskArn: liveArn(1), group: "family:gs-staging-p1", startedBy: "someone" };
  /** `total` tasks: the settled service task, then STOPPED history (and `extra` last). */
  const population = (total: number, extra: readonly Record<string, unknown>[] = []) => [SETTLED, ...Array.from({ length: Math.max(0, total - 1 - extra.length) }, (_, i) => stoppedTask(i + 1)), ...extra].slice(0, total);
  const judgeDoc = (doc: unknown, running: unknown = RUNNING_TASKS) => checkClusterTasks(doc, PREREQ, running, SERVICES, CAPTURE);
  const failed = (checks: readonly Check[]) => failures(checks).map((c) => `${c.name}: ${c.detail}`).join("\n");

  test("0, 1, 100, 101 and 250+ tasks: complete, paged and batched -- a settled service passes, the 101st / 257th stray FAILS", () => {
    const zero = clusterListing([]);
    const read0 = readClusterListing(zero, "staging");
    assert.ok(read0.ok && read0.arns === 0 && read0.pages.RUNNING === 1 && read0.pages.STOPPED === 1, JSON.stringify(read0));
    /* Nothing listed is no proof that the service's task is listed: FAIL, never "nothing beside it". */
    assert.match(failed(judgeDoc(zero)), /no task beside the services: the cluster listing is incomplete: it lacks 1/);
    for (const total of [1, 100, 101, 257]) {
      const doc = clusterListing(population(total));
      const read = readClusterListing(doc, "staging");
      assert.ok(read.ok, `${total}: ${JSON.stringify(read)}`);
      assert.equal(read.arns, total);
      assert.equal(doc.batches.length, Math.ceil(total / DESCRIBE_TASKS_BATCH));
      assert.ok(doc.batches.every((b) => b.tasks.length <= DESCRIBE_TASKS_BATCH));
      assert.equal(read.pages.STOPPED, Math.max(1, Math.ceil((total - 1) / 100)));
      assert.equal(failed(judgeDoc(doc)), "", `${total} tasks, one settled service task: PASS`);
    }
    /* LIVE-6 W1 compatibility: a complete listing captured before W1 (batches of 100) still judges complete. */
    const legacy = clusterListing(population(257)) as any;
    const described = legacy.batches.flatMap((b: any) => b.tasks);
    legacy.batches = [0, 100, 200].map((i) => ({ tasks: described.slice(i, i + DESCRIBE_TASKS_BATCH_MAX), failures: [] }));
    assert.deepEqual(legacy.batches.map((b: any) => b.tasks.length), [100, 100, 57]);
    assert.equal(failed(judgeDoc(legacy)), "", "a pre-W1 package of 100-task batches");
    /* The task past the old `taskArns[:100]` cut: a stray draining task (desired STOPPED, still RUNNING) as the 101st and
       the 257th task -- in the last page and the last batch. */
    for (const total of [101, 257]) {
      const lastOne = { ...STRAY, desiredStatus: "STOPPED", lastStatus: "RUNNING" };
      const doc = clusterListing(population(total, [lastOne]));
      assert.equal(doc.batches.at(-1)?.tasks.at(-1)?.taskArn, lastOne.taskArn);
      assert.match(failed(judgeDoc(doc)), /no task beside the services: task\(s\) outside the services: .*family:gs-staging-p1/);
    }
  });

  test("several list-tasks pages and describe batches: the page chain is judged -- a truncated, gapped or unended listing FAILS", () => {
    const tasks = population(257);
    const paged = clusterListing(tasks, { pageSize: 7 });
    assert.equal(paged.listings[1].pages.length, 37);
    assert.equal(failed(judgeDoc(paged)), "");
    const cases: Array<[string, (v: any) => void, RegExp]> = [
      ["the last page dropped (stopped early)", (v) => v.listings[1].pages.pop(), /ends on a page that had a next token \(the listing stopped early: truncated\)/],
      ["the last page claims a next token", (v) => (v.listings[1].pages.at(-1).more = true), /truncated/],
      ["a page in the middle missing", (v) => v.listings[1].pages.splice(5, 1), /page 5 is numbered 6/],
      ["a middle page with no next token", (v) => (v.listings[1].pages[3].more = false), /page 3 had no next token, yet more pages follow/],
      ["no page at all", (v) => (v.listings[0].pages = []), /desired-RUNNING listing has no page/],
      ["only the RUNNING listing (the old capture)", (v) => v.listings.pop(), /not exactly RUNNING and STOPPED/],
      ["RUNNING listed twice", (v) => (v.listings[1].desired_status = "RUNNING"), /not exactly RUNNING and STOPPED/],
      ["STOPPED listed before RUNNING", (v) => v.listings.reverse(), /not exactly RUNNING and STOPPED, in that order/],
      ["a count that is not the pages'", (v) => (v.task_count -= 1), /counts 256 task\(s\), but its pages list 257/],
      ["a listed task never described (the last batch lost)", (v) => v.batches.pop(), /7 listed task\(s\) were never described/],
      ["a batch over the DescribeTasks limit", (v) => (v.batches[0].tasks.push(...v.batches[1].tasks, ...v.batches[2].tasks), v.batches.splice(1, 2)), /batch 0 describes 150 task\(s\), not 1-100/],
      ["one task over the DescribeTasks limit", (v) => (v.batches[0].tasks.push(...v.batches[1].tasks, v.batches[2].tasks.shift()), v.batches.splice(1, 1)), /batch 0 describes 101 task\(s\), not 1-100/],
      ["an empty batch", (v) => v.batches.push({ tasks: [], failures: [] }), /batch 6 describes 0 task\(s\)/],
      ["a partial describe (MISSING)", (v) => (v.batches[2].failures = [{ arn: v.batches[2].tasks.pop().taskArn, reason: "MISSING" }]), /describe-tasks batch 2 failed for 1 task\(s\) .*MISSING.*: the listing is incomplete/],
      ["a batch without failures", (v) => delete v.batches[1].failures, /batch 1 is not a whole answer/],
      ["no batches", (v) => delete v.batches, /holds no describe-tasks batches/],
      ["a described task no page listed", (v) => v.batches.at(-1).tasks.push({ ...SETTLED, taskArn: liveArn(9) }), /describe-tasks answered 1 task\(s\) no page listed/],
      ["another cluster", (v) => (v.cluster = "gs-production"), /lists cluster gs-production, not gs-staging/],
      ["no listing time", (v) => delete v.listed_at, /no listing time/],
      ["a page entry that is not a task ARN", (v) => v.listings[1].pages[0].task_arns.push("arn:aws:ecs:us-east-1:111111111111:service/gs-staging/x"), /not a task ARN/],
      ["the old single answer", (v) => (Object.keys(v).forEach((k) => delete v[k]), (v.tasks = []), (v.failures = [])), /single desired-RUNNING answer/],
    ];
    for (const [label, mutate, expected] of cases) {
      const doc = clone(paged) as any;
      mutate(doc);
      const text = failed(judgeDoc(doc));
      assert.match(text, /the cluster listing is complete: /, label);
      assert.match(text, expected, `${label}: ${text}`);
      assert.match(text, /no task beside the services: the cluster listing is incomplete/, `${label}: never judged as "nothing beside"`);
    }
  });

  test("a draining task is visible only through desired STOPPED -- and FAILS; starting and old-revision tasks FAIL; STOPPED history passes", () => {
    const draining = { ...SETTLED, taskArn: liveArn(2), taskDefinitionArn: TD.replace(":7", ":6"), desiredStatus: "STOPPED", lastStatus: "DEACTIVATING" };
    const doc = clusterListing([SETTLED, draining]);
    assert.deepEqual(doc.listings[0].pages[0].task_arns, [TASK], "the desired-RUNNING listing alone never shows it");
    assert.deepEqual(doc.listings[1].pages[0].task_arns, [draining.taskArn]);
    assert.match(failed(judgeDoc(doc)), /task\(s\) draining or stopping: .*DEACTIVATING\/desired STOPPED/);
    for (const last of ["RUNNING", "STOPPING", "DEPROVISIONING"]) assert.match(failed(judgeDoc(clusterListing([SETTLED, { ...draining, lastStatus: last }]))), /draining or stopping/, last);
    const starting = { ...SETTLED, taskArn: liveArn(3), lastStatus: "PROVISIONING" };
    assert.match(failed(judgeDoc(clusterListing([SETTLED, starting]))), /task\(s\) starting: .*PROVISIONING/);
    const oldRevision = { ...SETTLED, taskArn: liveArn(4), taskDefinitionArn: TD.replace(":7", ":6") };
    assert.match(failed(judgeDoc(clusterListing([SETTLED, oldRevision]), { tasks: [SETTLED, oldRevision], failures: [] })), /replacement incomplete: .*gs-staging-p1:6 \(RUNNING\/desired RUNNING\), not the service's .*gs-staging-p1:7/);
    /* A settled service task running-tasks.json does not hold: the two captures disagree. */
    const second = { ...SETTLED, taskArn: liveArn(5) };
    assert.match(failed(judgeDoc(clusterListing([SETTLED, second]))), /service task\(s\) running-tasks.json does not hold/);
    /* Terminal tasks of any group (the certifier task, an old deployment's) are history, not action. */
    assert.equal(failed(judgeDoc(clusterListing([SETTLED, CERTIFIER_STOPPED, stoppedTask(1, { group: "family:gs-staging-p1" }), stoppedTask(2, { desiredStatus: "RUNNING" })]))), "");
  });

  test("an ARN listed under both desired statuses is described and judged once; deduplication never hides a second answer", () => {
    /* The task moved to desired STOPPED between the two listings: listed twice, described once, judged by its answer. */
    const moved = { ...STRAY, desiredStatus: "STOPPED", lastStatus: "STOPPED" };
    const overlap = clusterListing([SETTLED, moved], { alsoListedRunning: [moved.taskArn] });
    assert.equal(overlap.task_count, 2);
    assert.equal(failed(judgeDoc(overlap)), "");
    const stillLive = clusterListing([SETTLED, { ...moved, lastStatus: "RUNNING" }], { alsoListedRunning: [moved.taskArn] });
    assert.match(failed(judgeDoc(stillLive)), /outside the services/);
    /* Two answers for one ARN (a STOPPED one first, a live one second): refused -- never merged into the first. */
    const twice = clone(overlap) as any;
    twice.batches[0].tasks.push({ ...STRAY, desiredStatus: "RUNNING", lastStatus: "RUNNING" });
    assert.match(failed(judgeDoc(twice)), /described more than once/);
  });

  test("certification: the gate FAILS by name over each class; a settled package passes; a stale listing FAILS", async () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["the 257th task a stray", clusterListing(population(257, [{ ...STRAY, desiredStatus: "STOPPED", lastStatus: "STOPPING" }])), /no task beside the services: .*outside the services/],
      ["a draining service task", clusterListing([...RUNNING_TASKS.tasks, { ...SETTLED, taskArn: liveArn(6), desiredStatus: "STOPPED", lastStatus: "RUNNING" }]), /draining or stopping/],
      ["a truncated listing", ((v: any) => (v.listings[1].pages.pop(), v))(clusterListing(population(257))), /the cluster listing is complete: .*truncated/],
      ["a partial describe", ((v: any) => ((v.batches[0].failures = [{ arn: CERTIFIER_TASK, reason: "MISSING" }]), v))(clone(CLUSTER_TASKS)), /the cluster listing is complete: describe-tasks batch 0 failed/],
      ["a listing after capture.json", clusterListing([...RUNNING_TASKS.tasks], { listedAt: "2026-09-30T10:30:05Z" }), /the cluster listing is complete: the listing .* is not this capture's/],
      ["a listing from an older capture", clusterListing([...RUNNING_TASKS.tasks], { listedAt: new Date(Date.parse(TIMES.capture) - CLUSTER_LISTING_WINDOW_MS - 1000).toISOString() }), /is not this capture's/],
    ];
    for (const [label, listing, expected] of cases) {
      const built = await buildPackage({ mutate: { [EVIDENCE.clusterTasks]: () => listing } });
      try {
        const { result } = await verdictOf(built);
        assert.deepEqual(failedGates(result), ["prerequisite"], label);
        assert.match(gateFailures(result, "prerequisite").join("\n"), expected, label);
      } finally {
        cleanup(built.dir);
      }
    }
    /* A listing inside the capture window but taken before the last probe finished (capture.json stamped after them). */
    const early = await buildPackage({ mutate: { [EVIDENCE.capture]: (v) => ({ ...v, captured_at: "2026-09-30T10:20:00Z" }), [EVIDENCE.clusterTasks]: () => clusterListing([...RUNNING_TASKS.tasks], { listedAt: "2026-09-30T10:10:00Z" }) } });
    const settled = await buildPackage({ mutate: { [EVIDENCE.clusterTasks]: () => clusterListing(population(257)) } });
    try {
      const { result } = await verdictOf(early);
      assert.deepEqual(gateFailures(result, "prerequisite").filter((f) => !/unchanged since the probes began/.test(f)), ["prerequisite: cluster listing taken after the probes: listed 2026-09-30T10:10:00.000Z, before the last probe finished (2026-09-30T10:16:10.000Z): run capture-evidence again, then certify"]);
      const good = (await verdictOf(settled)).result;
      assert.ok(good.passed, JSON.stringify(failedGates(good)));
      const prereq = good.gates.find((g) => g.id === "prerequisite");
      assert.ok(prereq?.checks.some((c) => c.name === "prerequisite: the cluster listing is complete" && c.status === "pass" && /257 task\(s\)/.test(c.detail)));
    } finally {
      cleanup(early.dir);
      cleanup(settled.dir);
    }
  });
});

/* ------------------------------------------------------------------ */
/* L6-6P: capture-evidence.{sh,ps1} against a stub AWS CLI              */
/* ------------------------------------------------------------------ */

/** The AWS CLI as the scripts call it: list-tasks pages (max 100, --no-paginate, the page query), describe-tasks (refusing
 *  more than 100 ARNs, like the API; a task named by ARN or by ID), failure injection; every other call answers `{}` /
 *  `None`. Every call is logged. LIVE-6 W1: on EVERY platform it refuses a call whose command line, as cmd.exe would run
 *  its `aws.cmd` (the node binary, the stub, then the arguments), exceeds cmd.exe's 8191 characters -- the owner's
 *  Windows gate failed there ("The command line is too long.") while Linux passed, so the bound is now checked where the
 *  scripts are tested, not only where cmd.exe happens to run them. */
const CMD_LINE_MAX = 8191;
const AWS_STUB = String.raw`
const fs = require("fs");
const sc = JSON.parse(fs.readFileSync(process.env.AWS_STUB_SCENARIO, "utf8"));
const argv = process.argv.slice(2);
{
  const quote = (a) => (a === "" || /[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a);
  const line = [process.execPath, process.argv[1], ...argv].map(quote).join(" ");
  if (line.length > ${CMD_LINE_MAX}) {
    fs.appendFileSync(process.env.AWS_STUB_LOG, JSON.stringify({ op: "cmd.exe", error: "The command line is too long.", length: line.length }) + "\n");
    process.stderr.write("The command line is too long.\n");
    process.exit(1);
  }
}
const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const log = (entry) => fs.appendFileSync(process.env.AWS_STUB_LOG, JSON.stringify(entry) + "\n");
const si = argv.findIndex((a) => ["ecs", "elbv2", "cloudfront", "ec2", "cloudwatch"].includes(a));
const svc = argv[si], op = argv[si + 1], output = opt("--output") || "json", query = opt("--query");
const die = (message) => { log({ op, error: message }); process.stderr.write(message + "\n"); process.exit(254); };
const json = (v) => process.stdout.write(JSON.stringify(v, null, 4) + "\n");
/* drain-pool: once update-service scaled the service down, its desired-RUNNING tasks are desired STOPPED (and described
   STOPPED, exit 0). Only drain-pool calls update-service, so the capture scripts never see this state. */
const scaledMark = process.env.AWS_STUB_SCENARIO + ".scaled";
const scaled = fs.existsSync(scaledMark);
const drained = (t) => (scaled && t.desiredStatus === "RUNNING" ? { ...t, desiredStatus: "STOPPED", lastStatus: "STOPPED", containers: (t.containers || []).map((c) => ({ ...c, lastStatus: "STOPPED", exitCode: 0 })) } : t);
sc.tasks = sc.tasks.map(drained);
const byArn = new Map(sc.tasks.map((t) => [t.taskArn, t]));
if (svc === "ecs" && op === "update-service") {
  log({ op, service: opt("--service"), desired: opt("--desired-count") });
  fs.writeFileSync(scaledMark, "1");
  process.stdout.write(opt("--desired-count") + "\n");
} else if (svc === "ecs" && op === "wait") {
  /* ecs wait tasks-stopped: like the API, every identifier must be a task ARN (or ID) -- PowerShell 5.1 splatting a
     STRING passes its characters one by one ("a", "r", "n", ...), which the real API refuses as malformed. */
  const i = argv.indexOf("--tasks");
  const named = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith("--"); j += 1) named.push(argv[j]);
  log({ op: "wait " + argv[si + 2], count: named.length, tasks: named });
  const bad = named.filter((n) => !byArn.has(n));
  if (named.length === 0 || named.length > 100 || bad.length > 0) die("An error occurred (InvalidParameterException) when calling the DescribeTasks operation: Invalid identifier: " + (bad[0] || "none"));
} else if (svc === "ecs" && op === "describe-services" && query === "services[0].[runningCount,pendingCount]") {
  log({ op, counts: true });
  process.stdout.write(JSON.stringify(scaled ? [0, 0] : [sc.tasks.filter((t) => t.desiredStatus === "RUNNING").length, 0]) + "\n");
} else if (svc === "ecs" && op === "list-tasks") {
  const status = opt("--desired-status"), service = opt("--service-name");
  if (service === undefined && query === "taskArns[]") {
    /* capture-restore-stop: the whole cluster's ARNs of one desired status (the CLI follows every page itself). */
    log({ op, status, whole: true });
    process.stdout.write((sc.listing[status] || []).join("\t") + "\n");
    process.exit(0);
  }
  if (service !== undefined) {
    log({ op, service, status });
    /* L6-2's per-service capture asks for the first 100 (--query 'taskArns[:100]'); L6-6's running list asks for all. */
    const arns = sc.tasks.filter((t) => t.group === "service:" + service && t.desiredStatus === status).map((t) => t.taskArn);
    process.stdout.write((query === "taskArns[:100]" ? arns.slice(0, 100) : arns).join("\t") + "\n");
    process.exit(0);
  }
  if (query !== sc.pageQuery) die("unexpected --query " + query);
  if (!argv.includes("--no-paginate") || opt("--max-results") !== "100" || output !== "text") die("not one bounded page");
  const all = sc.listing[status];
  if (!Array.isArray(all)) die("InvalidParameterException: desiredStatus " + status);
  const token = opt("--next-token");
  if (token !== undefined && !token.startsWith(status + ":")) die("InvalidParameterException: nextToken");
  const start = token === undefined ? 0 : Number(token.slice(status.length + 1));
  const size = sc.pageSize || 100;
  const page = all.slice(start, start + size);
  const next = start + size < all.length ? status + ":" + (start + size) : "";
  const index = Math.floor(start / size);
  log({ op, status, token: token === undefined ? null : token, page: index, count: page.length });
  if (sc.failList && sc.failList.status === status && sc.failList.page === index) die("An error occurred (ThrottlingException) when calling the ListTasks operation: Rate exceeded");
  process.stdout.write("T=" + next + "\t" + page.join(" ") + "\n");
} else if (svc === "ecs" && op === "describe-tasks") {
  const i = argv.indexOf("--tasks");
  const named = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith("--"); j += 1) named.push(argv[j]);
  /* DescribeTasks takes a full ARN or a task ID (the ARN's last segment, with --cluster); the answer names the ARN. */
  const arns = named.map((n) => (n.startsWith("arn:") ? n : (sc.tasks.find((t) => t.taskArn.endsWith("/" + n)) || { taskArn: n }).taskArn));
  log({ op, count: arns.length, first: arns[0] || null, by: named.length > 0 && named.every((n) => !n.startsWith("arn:")) ? "id" : "arn" });
  if (arns.length === 0 || arns.length > 100) die("InvalidParameterException: tasks must hold 1-100 ARNs, not " + arns.length);
  if (sc.describeFailOn && arns.includes(sc.describeFailOn)) die("An error occurred (ServerException) when calling the DescribeTasks operation");
  const missing = (sc.describeMissing || []);
  json({ tasks: arns.filter((a) => byArn.has(a) && !missing.includes(a)).map((a) => byArn.get(a)), failures: arns.filter((a) => !byArn.has(a) || missing.includes(a)).map((a) => ({ arn: a, reason: "MISSING" })) });
} else if (svc === "ecs" && op === "describe-services") {
  log({ op });
  if (query !== undefined) process.stdout.write(sc.services.services[0].taskDefinition + "\n");
  else json(sc.services);
} else {
  /* LIVE-6 final convergence: which names a describe asked for (the converged capture's target groups). */
  const names = [];
  const ni = argv.indexOf("--names");
  for (let j = ni + 1; ni >= 0 && j < argv.length && !argv[j].startsWith("--"); j += 1) names.push(argv[j]);
  log({ op, service: svc, names });
  if (output === "text") process.stdout.write("None\n");
  else json({});
}
`;

const SCRIPTS = path.join(INFRA, "scripts");
const PAGE_QUERY = "[join('', ['T=', nextToken || '']), join(' ', taskArns)]";
function probeShell(candidates: readonly string[], args: readonly string[]): string | null {
  for (const c of candidates) if (spawnSync(c, args, { encoding: "utf8", timeout: 60_000 }).status === 0) return c;
  return null;
}
/* bash on Windows may be WSL's (another filesystem): the .sh contract runs where bash is the host's. */
const BASH = process.platform === "win32" ? null : probeShell(["bash"], ["-c", "exit 0"]);
const PWSH = probeShell(process.platform === "win32" ? ["pwsh", "powershell"] : ["pwsh"], ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]);

interface StubScenario {
  readonly tasks: readonly Record<string, unknown>[];
  readonly listing?: { readonly RUNNING: readonly string[]; readonly STOPPED: readonly string[] };
  readonly pageSize?: number;
  readonly failList?: { readonly status: string; readonly page: number };
  readonly describeFailOn?: string;
  readonly describeMissing?: readonly string[];
}
interface CaptureRun {
  readonly status: number | null;
  readonly stderr: string;
  readonly out: string;
  readonly calls: readonly Record<string, unknown>[];
  readonly file: (name: string) => unknown;
  readonly exists: (name: string) => boolean;
}

/** The cluster listing's describe batches: every describe-tasks after its last list-tasks page (the per-service captures
 *  of L6-2 and L6-6's running-tasks.json come before the listing). */
function clusterBatchesOf(calls: readonly Record<string, unknown>[]): number[] {
  const lastPage = calls.map((c, i) => (c.op === "list-tasks" && c.service === undefined ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  return calls.filter((c, i) => i > lastPage && c.op === "describe-tasks").map((c) => Number(c.count));
}

function runCapture(shell: "sh" | "ps1", scenario: StubScenario, script: "capture-evidence" | "capture-restore-stop" = "capture-evidence"): CaptureRun {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gs-l66p-"));
  const bin = path.join(root, "bin");
  const out = path.join(root, "evidence");
  fs.mkdirSync(bin);
  fs.mkdirSync(out);
  /* A stale, complete-looking capture: a failed run must not leave it standing. */
  fs.writeFileSync(path.join(out, "capture.json"), JSON.stringify({ format: "18COSMOS/L5-8-CAPTURE/v1", captured_at: "2026-09-30T09:00:00Z" }));
  fs.writeFileSync(path.join(out, "cluster-tasks.json"), JSON.stringify(CLUSTER_TASKS));
  fs.writeFileSync(path.join(bin, "aws-stub.js"), AWS_STUB);
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "aws.cmd"), `@"${process.execPath}" "%~dp0aws-stub.js" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
  else fs.writeFileSync(path.join(bin, "aws"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "aws-stub.js")}" "$@"\n`, { mode: 0o755 });
  const listing = scenario.listing ?? { RUNNING: scenario.tasks.filter((t) => t.desiredStatus === "RUNNING").map((t) => String(t.taskArn)), STOPPED: scenario.tasks.filter((t) => t.desiredStatus !== "RUNNING").map((t) => String(t.taskArn)) };
  fs.writeFileSync(path.join(root, "scenario.json"), JSON.stringify({ ...scenario, listing, pageQuery: PAGE_QUERY, services: SERVICES }));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, AWS_STUB_SCENARIO: path.join(root, "scenario.json"), AWS_STUB_LOG: path.join(root, "calls.log") };
  const args =
    script === "capture-evidence"
      ? { sh: ["staging", "us-east-1", "p1", "E123", out], ps1: ["-Environment", "staging", "-Region", "us-east-1", "-PrimaryPool", "p1", "-Distribution", "E123", "-Out", out] }
      : { sh: ["staging", "us-east-1", RUN, "drill-0930", out, "p1"], ps1: ["-Environment", "staging", "-Region", "us-east-1", "-Run", RUN, "-RestoreId", "drill-0930", "-Out", out, "-Pools", "p1"] };
  const r =
    shell === "sh"
      ? spawnSync(BASH as string, [path.join(SCRIPTS, `${script}.sh`), ...args.sh], { env, encoding: "utf8", timeout: 300_000 })
      : spawnSync(PWSH as string, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(SCRIPTS, `${script}.ps1`), ...args.ps1], { env, encoding: "utf8", timeout: 300_000 });
  const logText = fs.existsSync(env.AWS_STUB_LOG) ? fs.readFileSync(env.AWS_STUB_LOG, "utf8") : "";
  const calls = logText.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  const text = (name: string) => fs.readFileSync(path.join(out, name), "utf8").replace(/^﻿/, "");
  return { status: r.status, stderr: `${r.stderr ?? ""}${r.error ? String(r.error) : ""}`, out, calls, file: (name) => JSON.parse(text(name)), exists: (name) => fs.existsSync(path.join(out, name)) };
}

describe("L6-6P: capture-evidence.{sh,ps1} write the complete listing (stub AWS CLI; no AWS)", () => {
  const PREREQ = { environment: "staging", pools: ["p1"], primaryPool: "p1" };
  const SETTLED = RUNNING_TASKS.tasks[0] as Record<string, unknown>;
  const history = (n: number) => Array.from({ length: n }, (_, i) => stoppedTask(i + 1));
  const straying = { ...SETTLED, taskArn: `arn:aws:ecs:us-east-1:111111111111:task/gs-staging/${"5".repeat(32)}`, group: "family:gs-staging-p1", desiredStatus: "STOPPED", lastStatus: "STOPPING" };
  const judged = (run: CaptureRun) => {
    const checks = checkClusterTasks(run.file("cluster-tasks.json"), PREREQ, run.file("running-tasks.json"), run.file("services.json"), run.file("capture.json"));
    return failures(checks).map((c) => `${c.name}: ${c.detail}`).join("\n");
  };
  const shells: Array<["sh" | "ps1", string | null]> = [
    ["sh", BASH],
    ["ps1", PWSH],
  ];
  const outputs: Partial<Record<"sh" | "ps1", Record<string, unknown>>> = {};

  for (const [shell, exe] of shells) {
    const skip = exe === null ? `${shell === "sh" ? "bash" : "PowerShell"} is not available here` : false;

    test(`${shell}: 0, 1, 100, 101 and 257 tasks -- every page followed, every ARN described in batches of <= ${DESCRIBE_TASKS_BATCH}`, { skip }, () => {
      for (const total of [0, 1, 100, 101, 257]) {
        const tasks = total === 0 ? [] : [SETTLED, ...history(total - 1)];
        const run = runCapture(shell, { tasks });
        assert.equal(run.status, 0, `${total}: ${run.stderr}`);
        const doc = run.file("cluster-tasks.json") as any;
        assert.equal(doc.format, CLUSTER_TASKS_FORMAT);
        const read = readClusterListing(doc, "staging");
        assert.ok(read.ok, `${total}: ${JSON.stringify(read)}`);
        assert.equal(read.arns, total);
        const describes = run.calls.filter((c) => c.op === "describe-tasks").map((c) => Number(c.count));
        /* The per-service describes (L6-2's stopped / running captures, L6-6's running-tasks.json) come first; the
           cluster's batches are the describes after the cluster listing's last page (converged capture). */
        const clusterBatches = clusterBatchesOf(run.calls);
        assert.deepEqual(clusterBatches, Array.from({ length: Math.ceil(total / DESCRIBE_TASKS_BATCH) }, (_, i) => Math.min(DESCRIBE_TASKS_BATCH, total - i * DESCRIBE_TASKS_BATCH)), `${total}: batches ${JSON.stringify(describes)}`);
        /* Every describe-tasks call of the capture -- the per-pool views' too -- fit the stub's cmd.exe line (it refuses one
           that would not, on every platform) and the API's 100. */
        assert.ok(describes.every((n) => n >= 1 && n <= DESCRIBE_TASKS_BATCH_MAX), JSON.stringify(describes));
        const pages = run.calls.filter((c) => c.op === "list-tasks" && c.service === undefined);
        assert.deepEqual(pages.map((c) => c.status), ["RUNNING", ...Array.from({ length: Math.max(1, Math.ceil((total - 1) / 100)) }, () => "STOPPED")], `${total}`);
        assert.equal(run.exists("cluster-tasks.json.partial"), false);
        if (total === 0) assert.match(judged(run), /no task beside the services: the cluster listing is incomplete/);
        else assert.equal(judged(run), "", `${total}: ${judged(run)}`);
        if (total === 257) outputs[shell] = doc;
        fs.rmSync(path.dirname(run.out), { recursive: true, force: true });
      }
    });

    test(`${shell}: many list-tasks pages chained by next token; the draining stray on the last page FAILS the prerequisite`, { skip }, () => {
      const tasks = [SETTLED, ...history(255), straying];
      const run = runCapture(shell, { tasks, pageSize: 7 });
      assert.equal(run.status, 0, run.stderr);
      const pages = run.calls.filter((c) => c.op === "list-tasks" && c.service === undefined && c.status === "STOPPED");
      assert.equal(pages.length, 37);
      pages.forEach((c, i) => assert.equal(c.token, i === 0 ? null : `STOPPED:${i * 7}`, "each page asked with the previous page's token"));
      const read = readClusterListing(run.file("cluster-tasks.json"), "staging");
      assert.ok(read.ok && read.arns === 257 && read.pages.STOPPED === 37, JSON.stringify(read));
      assert.match(judged(run), /outside the services: 5{32} family:gs-staging-p1 .*\(STOPPING\/desired STOPPED\)/);
      /* A desired-RUNNING stray on the RUNNING listing's second page. */
      const second = runCapture(shell, { tasks: [SETTLED, { ...straying, desiredStatus: "RUNNING", lastStatus: "RUNNING" }], pageSize: 1 });
      assert.equal(second.status, 0, second.stderr);
      assert.equal(second.calls.filter((c) => c.op === "list-tasks" && c.status === "RUNNING" && c.service === undefined).length, 2);
      assert.match(judged(second), /outside the services/);
      for (const r of [run, second]) fs.rmSync(path.dirname(r.out), { recursive: true, force: true });
    });

    test(`${shell}: a task listed under both desired statuses is described once`, { skip }, () => {
      const moved = stoppedTask(77, { group: "family:gs-staging-p1" });
      const run = runCapture(shell, { tasks: [SETTLED, moved], listing: { RUNNING: [TASK, moved.taskArn], STOPPED: [moved.taskArn] } });
      assert.equal(run.status, 0, run.stderr);
      const doc = run.file("cluster-tasks.json") as any;
      assert.equal(doc.task_count, 2);
      assert.deepEqual(doc.listings.map((l: any) => l.pages[0].task_arns.length), [2, 1]);
      assert.deepEqual(clusterBatchesOf(run.calls), [2]);
      assert.equal(judged(run), "");
      fs.rmSync(path.dirname(run.out), { recursive: true, force: true });
    });

    test(`${shell}: a failed list-tasks page or describe-tasks batch fails the capture -- no listing, no stamp, nothing stale left`, { skip }, () => {
      const tasks = [SETTLED, ...history(256)];
      for (const scenario of [{ tasks, failList: { status: "STOPPED", page: 1 } }, { tasks, failList: { status: "RUNNING", page: 0 } }, { tasks, describeFailOn: String(history(256)[230].taskArn) }] as StubScenario[]) {
        const run = runCapture(shell, scenario);
        assert.notEqual(run.status, 0, JSON.stringify(scenario.failList ?? scenario.describeFailOn));
        /* LIVE-6 W1: it failed on the INJECTED call -- not on a command line too long for cmd.exe, which would make this
           test pass on a capture that can never succeed (the owner's Windows run). */
        const errors = run.calls.filter((c) => c.error !== undefined).map((c) => String(c.error));
        assert.deepEqual(errors.map((e) => /ThrottlingException|ServerException/.test(e)), [true], errors.join("; "));
        assert.equal(run.exists("cluster-tasks.json"), false, "no listing that looks complete");
        assert.equal(run.exists("capture.json"), false, "no stamp: the certification refuses the package");
        fs.rmSync(path.dirname(run.out), { recursive: true, force: true });
      }
      /* A describe answer carrying failures is written whole -- and the judgment refuses it. */
      const partial = runCapture(shell, { tasks, describeMissing: [String(history(256)[150].taskArn)] });
      assert.equal(partial.status, 0, partial.stderr);
      /* history[150] is the 152nd distinct ARN (the settled task first): batch 3 of 50. */
      assert.match(judged(partial), /the cluster listing is complete: describe-tasks batch 3 failed for 1 task\(s\) .*MISSING/);
      fs.rmSync(path.dirname(partial.out), { recursive: true, force: true });
    });

    test(`${shell}: the capture is read-only -- list, describe and get calls only`, { skip }, () => {
      const run = runCapture(shell, { tasks: [SETTLED, ...history(3)] });
      assert.equal(run.status, 0, run.stderr);
      const ops = [...new Set(run.calls.map((c) => String(c.op)))];
      assert.deepEqual(ops.filter((op) => !/^(list|describe|get)-/.test(op)), [], ops.join(", "));
      fs.rmSync(path.dirname(run.out), { recursive: true, force: true });
    });
  }

  for (const [shell, exe] of shells) {
    test(`${shell}: LIVE-6 final convergence -- one capture keeps L6-2's per-pool files, L6-5B's alarms and manifest, and L6-6P's listing and stamp`, { skip: exe === null ? `${shell === "sh" ? "bash" : "PowerShell"} is not available here` : false }, () => {
      const run = runCapture(shell, { tasks: [SETTLED, ...history(3)] });
      try {
        assert.equal(run.status, 0, run.stderr);
        for (const file of ["services.json", "task-definition-p1.json", "target-groups.json", "target-health-p1.json", "stopped-tasks-p1.json", "running-tasks-p1.json", "alarms.json", "manifest.json", "running-tasks.json", "cluster-tasks.json", "target-health.json", "distribution.json", "capture.json"]) assert.ok(run.exists(file), `${file} is captured`);
        assert.ok(fs.existsSync(path.join(run.out, "task-definition-revisions-p1")), "L6-2's tagged revisions directory");
        const manifest = run.file("manifest.json") as Record<string, unknown>;
        assert.deepEqual([manifest.format, manifest.environment, manifest.pools], ["18COSMOS/EVIDENCE/v1", "staging", ["p1"]]);
        assert.ok(Number.isFinite(Date.parse(String(manifest.captured_at))) && /Z$/.test(String(manifest.captured_at)), `culture-invariant UTC: ${String(manifest.captured_at)}`);
        assert.equal((run.file("cluster-tasks.json") as { format: string }).format, CLUSTER_TASKS_FORMAT, "L6-6P's complete listing, not a truncated one");
        const groups = run.calls.filter((c) => c.op === "describe-target-groups").flatMap((c) => (c.names as string[]) ?? []);
        assert.ok(groups.includes("gs-staging-p1") && !groups.includes("gs-staging-primary"), `per-pool target groups only (L6-2): ${groups.join(", ")}`);
        assert.ok(run.calls.some((c) => c.op === "describe-alarms"), "L6-5B's alarms");
        /* The stamp is written LAST: after the listing, the alarms and the manifest. */
        const order = run.calls.map((c) => String(c.op));
        assert.ok(order.lastIndexOf("describe-alarms") < order.lastIndexOf("describe-tasks"), "the alarms before the cluster listing's batches (the listing stays next to the stamp)");
      } finally {
        fs.rmSync(path.dirname(run.out), { recursive: true, force: true });
      }
    });
  }

  test("LIVE-6 W1: the stub refuses what cmd.exe refuses (100 full task ARNs), and the capture's calls fit (50 ARNs, 100 IDs)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gs-w1-stub-"));
    try {
      const tasks = [SETTLED, ...history(120)];
      fs.writeFileSync(path.join(root, "aws-stub.js"), AWS_STUB);
      fs.writeFileSync(path.join(root, "scenario.json"), JSON.stringify({ tasks, listing: { RUNNING: [], STOPPED: [] }, pageQuery: PAGE_QUERY, services: SERVICES }));
      const env = { ...process.env, AWS_STUB_SCENARIO: path.join(root, "scenario.json"), AWS_STUB_LOG: path.join(root, "calls.log") };
      const describe = (names: readonly string[]) => spawnSync(process.execPath, [path.join(root, "aws-stub.js"), "--region", "us-east-1", "--output", "json", "ecs", "describe-tasks", "--cluster", "gs-staging", "--tasks", ...names], { env, encoding: "utf8" });
      const arns = tasks.map((t) => String(t.taskArn));
      const ids = arns.map((a) => a.slice(a.lastIndexOf("/") + 1));
      const tooLong = describe(arns.slice(0, DESCRIBE_TASKS_BATCH_MAX));
      assert.equal(tooLong.status, 1);
      assert.match(tooLong.stderr, /The command line is too long\./, "100 full ARNs: the owner's Windows failure, reproduced on this platform");
      for (const names of [arns.slice(0, DESCRIBE_TASKS_BATCH), ids.slice(0, DESCRIBE_TASKS_BATCH_MAX)]) {
        const ok = describe(names);
        assert.equal(ok.status, 0, ok.stderr);
        const answer = JSON.parse(ok.stdout) as { tasks: Array<{ taskArn: string }>; failures: unknown[] };
        assert.deepEqual(answer.tasks.map((t) => t.taskArn), arns.slice(0, names.length), "named by ARN either way");
        assert.deepEqual(answer.failures, []);
      }
      /* The bound holds with margin for a longer environment name than the tests use (gs-production, ~4.4k characters). */
      const production = arns.slice(0, DESCRIBE_TASKS_BATCH).map((a) => a.replace("gs-staging", "gs-production"));
      assert.ok(production.join(" ").length + 600 < CMD_LINE_MAX, "50 production-length ARNs plus a long install path");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /* LIVE-6 W1: the restore drill's stop capture batches the same way; L6-2's per-pool view stays one whole answer. */
  const restoreOutputs: Partial<Record<"sh" | "ps1", unknown>> = {};
  for (const [shell, exe] of shells) {
    const skip = exe === null ? `${shell === "sh" ? "bash" : "PowerShell"} is not available here` : false;

    test(`${shell}: capture-restore-stop describes every task (257) in whole batches of 1-${DESCRIBE_TASKS_BATCH}; a failed batch fails it`, { skip }, () => {
      const tasks = [SETTLED, ...history(256)];
      const run = runCapture(shell, { tasks }, "capture-restore-stop");
      try {
        assert.equal(run.status, 0, run.stderr);
        const doc = run.file("restore-stop/cluster-tasks.json") as { batches: Array<{ tasks: Array<{ taskArn: string }>; failures: unknown[] }> };
        assert.deepEqual(doc.batches.map((b) => b.tasks.length), [50, 50, 50, 50, 50, 7]);
        assert.ok(doc.batches.every((b) => Array.isArray(b.failures) && b.failures.length === 0), "each answer whole");
        const described = doc.batches.flatMap((b) => b.tasks.map((t) => t.taskArn));
        assert.deepEqual(described, tasks.map((t) => String(t.taskArn)), "every listed task described, once, in order");
        assert.ok(run.calls.filter((c) => c.op === "describe-tasks").every((c) => Number(c.count) <= DESCRIBE_TASKS_BATCH));
        restoreOutputs[shell] = doc;
      } finally {
        fs.rmSync(path.dirname(run.out), { recursive: true, force: true });
      }
      const failed = runCapture(shell, { tasks, describeFailOn: String(history(256)[200].taskArn) }, "capture-restore-stop");
      try {
        assert.notEqual(failed.status, 0, "a failed describe-tasks batch fails the capture");
        assert.deepEqual(failed.calls.filter((c) => c.error !== undefined).map((c) => /ServerException/.test(String(c.error))), [true]);
        assert.equal(failed.exists("restore-stop/stamp.json"), false, "no stamp after a failed batch");
      } finally {
        fs.rmSync(path.dirname(failed.out), { recursive: true, force: true });
      }
    });

    test(`${shell}: L6-2's per-pool view is still ONE whole describe-tasks answer for its first 100 tasks (asked by task ID)`, { skip }, () => {
      const run = runCapture(shell, { tasks: [SETTLED, ...history(150)] });
      try {
        assert.equal(run.status, 0, run.stderr);
        const stopped = run.file("stopped-tasks-p1.json") as { tasks: Array<{ taskArn: string }>; failures: unknown[] };
        assert.deepEqual(stopped.tasks.map((t) => t.taskArn), history(100).map((t) => String(t.taskArn)), "the first 100, by their ARNs");
        assert.deepEqual(stopped.failures, []);
        const perPool = run.calls.filter((c) => c.op === "describe-tasks" && c.by === "id");
        assert.deepEqual(perPool.map((c) => c.count), [100, 1], "one call per view: STOPPED (100), RUNNING (1)");
        assert.equal(run.calls.filter((c) => c.op === "cmd.exe").length, 0, "no call past cmd.exe's line");
      } finally {
        fs.rmSync(path.dirname(run.out), { recursive: true, force: true });
      }
    });
  }

  test("capture-restore-stop: .sh and .ps1 write the same batches", { skip: BASH === null || PWSH === null ? "needs both bash and PowerShell" : false }, () => {
    assert.ok(restoreOutputs.sh !== undefined && restoreOutputs.ps1 !== undefined, "both 257-task runs above produced a listing");
    assert.deepEqual(restoreOutputs.ps1, restoreOutputs.sh);
  });

  test(".sh and .ps1 write the same listing (contract equivalence; listed_at aside)", { skip: BASH === null || PWSH === null ? "needs both bash and PowerShell" : false }, () => {
    assert.ok(outputs.sh !== undefined && outputs.ps1 !== undefined, "the 257-task runs above produced both");
    const strip = (doc: Record<string, unknown>) => ({ ...doc, listed_at: typeof doc.listed_at === "string" && Number.isFinite(Date.parse(doc.listed_at)) });
    assert.deepEqual(strip(outputs.ps1 as Record<string, unknown>), strip(outputs.sh as Record<string, unknown>));
  });
});

/* ================================================================== */
/* LIVE-6 FINAL CONVERGENCE: the L6-4 binding, TASK# heartbeats, L6-5B  */
/* alarms, the gate records, the flip / rotation / restore drills       */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* drain-pool.ps1 against the stub AWS CLI (0, 1, many tasks)           */
/* ------------------------------------------------------------------ */

describe("drain-pool.ps1 writes the drain evidence for 0, 1 and many tasks (stub AWS CLI; no AWS)", () => {
  const skip = PWSH === null ? "PowerShell is not available here" : false;
  const SETTLED = RUNNING_TASKS.tasks[0] as Record<string, unknown>;
  const serving = (n: number) => Array.from({ length: n }, (_, i) => ({ ...SETTLED, taskArn: `arn:aws:ecs:us-east-1:111111111111:task/gs-staging/${String(i + 1).repeat(32).slice(0, 32)}` }));

  function runDrain(tasks: readonly Record<string, unknown>[]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gs-drain-"));
    const bin = path.join(root, "bin");
    const out = path.join(root, "evidence");
    fs.mkdirSync(bin);
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(bin, "aws-stub.js"), AWS_STUB);
    if (process.platform === "win32") fs.writeFileSync(path.join(bin, "aws.cmd"), `@"${process.execPath}" "%~dp0aws-stub.js" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
    else fs.writeFileSync(path.join(bin, "aws"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "aws-stub.js")}" "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(root, "scenario.json"), JSON.stringify({ tasks, listing: { RUNNING: [], STOPPED: [] }, pageQuery: PAGE_QUERY, services: SERVICES }));
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, AWS_STUB_SCENARIO: path.join(root, "scenario.json"), AWS_STUB_LOG: path.join(root, "calls.log") };
    const r = spawnSync(PWSH as string, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(SCRIPTS, "drain-pool.ps1"), "-Environment", "staging", "-Region", "us-east-1", "-Pool", "p1", "-Evidence", out, "-Run", RUN], { env, encoding: "utf8", timeout: 300_000 });
    const logText = fs.existsSync(env.AWS_STUB_LOG) ? fs.readFileSync(env.AWS_STUB_LOG, "utf8") : "";
    const calls = logText.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
    const file = (name: string) => JSON.parse(fs.readFileSync(path.join(out, "drain-p1", name), "utf8").replace(/^﻿/, ""));
    const exists = (name: string) => fs.existsSync(path.join(out, "drain-p1", name));
    return { root, status: r.status, stderr: `${r.stderr ?? ""}${r.error ? String(r.error) : ""}`, calls, file, exists };
  }

  for (const n of [1, 0, 3]) {
    test(`${n} serving task(s): scaled to 0, waited on exactly those ARNs, all four evidence files written${n === 1 ? " (the PowerShell 5.1 one-item regression)" : ""}`, { skip }, () => {
      const tasks = serving(n);
      const run = runDrain(tasks);
      try {
        assert.equal(run.status, 0, run.stderr);
        for (const name of ["tasks-before.json", "tasks-after.json", "service-after.json", "drain.json"]) assert.ok(run.exists(name), `${name} missing`);
        assert.deepEqual(run.file("tasks-before.json").tasks.map((t: any) => t.taskArn), tasks.map((t) => t.taskArn));
        assert.deepEqual(run.file("tasks-before.json").tasks.map((t: any) => t.desiredStatus), tasks.map(() => "RUNNING"), "listed before the scale-down");
        assert.deepEqual(run.file("tasks-after.json").tasks.map((t: any) => [t.taskArn, t.lastStatus, t.containers[0].exitCode]), tasks.map((t) => [t.taskArn, "STOPPED", 0]));
        assert.equal(run.file("drain.json").run_id, RUN);
        const ops = run.calls.map((c) => String(c.op));
        assert.ok(ops.indexOf("update-service") > 0 && ops.indexOf("update-service") < ops.lastIndexOf("describe-services"), ops.join(","));
        assert.deepEqual(run.calls.filter((c) => c.op === "update-service").map((c) => c.desired), ["0"]);
        const waits = run.calls.filter((c) => c.op === "wait tasks-stopped");
        /* The regression: one stopped task must reach the waiter as ONE whole ARN, never splatted character by character. */
        if (n === 0) assert.deepEqual(waits, [], "nothing stopped, nothing waited on");
        else assert.deepEqual(waits.map((c) => c.tasks), [tasks.map((t) => t.taskArn)]);
      } finally {
        cleanup(run.root);
      }
    });
  }
});

describe("LIVE-6 final convergence: the staging registry binds L6-2 / L6-4 / L6-5B / L6-7 through their own judges", () => {
  const drills = require("./drills") as typeof import("./drills");
  const { readRestoreHeartbeats, RESTORE_STOP_DIR, RESTORE_STOP_FORMAT } = require("./recovery") as typeof import("./recovery");
  const STOP_DIR = RESTORE_STOP_DIR;
  const reasons = (checks: readonly Check[]) => failures(checks).map((c) => `${c.name}: ${c.detail}`).join("\n");

  test("the registry: every scenario needs the alarms; each drill requires exactly its own gates (and FAILS without their evidence)", async () => {
    const built = await buildPackage();
    try {
      const base = await built.ctx();
      const status = (scenario: CertContext["scenario"], extra: Partial<CertContext> = {}) => Object.fromEntries(certify({ ...base, scenario, ...extra }).gates.map((g) => [g.id, g.status]));
      for (const scenario of ["read-only", "replacement", "restore-drill", "flip-drill", "relayer-rotation-drill"] as const) assert.notEqual(status(scenario).alarms, "not-required", scenario);
      const flip = status("flip-drill");
      assert.deepEqual([flip.flip, flip["flip-alarms"], flip["relayer-rotation"], flip["generation-gate"]], ["fail", "fail", "not-required", "not-required"]);
      const rotation = status("relayer-rotation-drill", { rotation: { from: RELAYER_OLD, to: relayerNew() } });
      assert.deepEqual([rotation["relayer-rotation"], rotation.flip, rotation["generation-gate"]], ["fail", "not-required", "not-required"]);
      const restore = status("restore-drill");
      assert.deepEqual([restore["generation-gate"], restore["restore-alarms"], restore.flip], ["fail", "fail", "not-required"]);
    } finally {
      cleanup(built.dir);
    }
  });

  test("alarms: the L6-5B contract judged by its own checkAlarmsEvidence, bound to this capture, account, region and names -- empty staging action lists pass", async () => {
    const built = await buildPackage();
    try {
      const run = async (mutate: (doc: any) => void, file: string = EVIDENCE_FILES.alarms, overrides: Partial<CertContext> = {}) => {
        const doc = clone(JSON.parse(fs.readFileSync(path.join(built.dir, file), "utf8")));
        mutate(doc);
        write(built.dir, file, doc);
        const gate = certify({ ...(await built.ctx()), ...overrides }).gates.find((g) => g.id === "alarms") as { status: string; checks: readonly Check[] };
        write(built.dir, file, file === EVIDENCE_FILES.alarms ? ALARMS : JSON.parse(JSON.stringify({ format: "18COSMOS/EVIDENCE/v1", captured_at: "2026-09-30T10:29:00Z", environment: "staging", region: "us-east-1", pools: ["p1"] })));
        return gate;
      };
      assert.equal((await run(() => undefined)).status, "pass");
      assert.equal((await run(() => undefined, EVIDENCE_FILES.alarms, { alarmActions: { page: [], ticket: [] } })).status, "pass", "`none` / `none` is a valid staging answer");
      const cases: Array<[string, (doc: any) => void, RegExp, string?]> = [
        ["actions disabled", (d) => (d.MetricAlarms[0].ActionsEnabled = false), /actions are DISABLED/],
        ["a metric's dimension", (d) => d.MetricAlarms[0].Metrics[0].MetricStat.Metric.Dimensions.push({ Name: "Task", Value: "t" }), /dimensions/],
        ["the namespace", (d) => (d.MetricAlarms[0].Metrics[0].MetricStat.Metric.Namespace = "Other"), /namespace/],
        ["the math", (d) => (d.MetricAlarms.find((a: any) => /a1-unexpected/.test(a.AlarmName)).Metrics.find((m: any) => m.Expression).Expression = "m1"), /expression/],
        ["a suppressor stuck in ALARM with no window", (d) => (d.MetricAlarms.find((a: any) => /flip-window$/.test(a.AlarmName)).StateValue = "ALARM"), /restored outside a window/],
        ["a composite suppressed by another pool's window", (d) => (d.CompositeAlarms[0].ActionsSuppressor = "gs-staging-p9-flip-window"), /composite/],
        ["a never-suppressed alarm wrapped", (d) => d.CompositeAlarms.push({ AlarmName: "x-notify", AlarmArn: "arn:aws:cloudwatch:us-east-1:111111111111:alarm:x-notify", AlarmRule: 'ALARM("gs-staging-a1-unexpected-task-loss")', ActionsEnabled: true }), /never suppressed/],
        ["the primary scope", (d) => (d.MetricAlarms.find((a: any) => /primary-a13/.test(a.AlarmName)).Metrics[0].MetricStat.Metric.Dimensions[1].Value = "p2"), /dimensions/],
        ["an unknown same-environment game-server alarm", (d) => d.MetricAlarms.push({ ...clone(d.MetricAlarms[0]), AlarmName: "gs-staging-p1-per-task-x", AlarmArn: "arn:aws:cloudwatch:us-east-1:111111111111:alarm:gs-staging-p1-per-task-x" }), /nothing outside the contract/],
        ["another account's alarm", (d) => (d.MetricAlarms[0].AlarmArn = d.MetricAlarms[0].AlarmArn.replace("111111111111", "999999999999")), /stable identity/],
        ["another region", (d) => (d.CompositeAlarms[0].AlarmArn = d.CompositeAlarms[0].AlarmArn.replace("us-east-1", "eu-west-1")), /stable identity/],
        ["no ARN", (d) => delete d.MetricAlarms[3].AlarmArn, /stable identity/],
        ["an alarm missing", (d) => d.MetricAlarms.splice(0, 1), /exists: not in the evidence/],
      ];
      for (const [label, mutate, want] of cases) {
        const gate = await run(mutate);
        assert.equal(gate.status, "fail", label);
        assert.match(reasons(gate.checks), want, label);
      }
      const other = await run((m) => (m.environment = "staging-x"), POOL_EVIDENCE_FILES.manifest);
      assert.match(reasons(other.checks), /captured for this environment and these pools/);
      const configured = await run(() => undefined, EVIDENCE_FILES.alarms, { alarmActions: { page: ["arn:aws:sns:us-east-1:111111111111:page"], ticket: [] } });
      assert.match(reasons(configured.checks), /page actions/, "a configured destination must be wired exactly");
      assert.ok(!/BUILD_ID/.test(JSON.stringify(configured)), "never bound to a BUILD_ID");
      fs.rmSync(path.join(built.dir, EVIDENCE_FILES.alarms));
      assert.match(reasons((certify(await built.ctx()).gates.find((g) => g.id === "alarms") as { checks: readonly Check[] }).checks), /alarms: evidence/);
    } finally {
      cleanup(built.dir);
    }
  });

  test("generation gate: the plan's generation_adoption is the gate's OPEN attestation, AND its adoption_claim is the ledger's APPGEN#HISTORY (read live)", async () => {
    const built = await buildPackage({ generation: { marker: RESTORED_MARKER, appgen: ADOPTED } });
    try {
      writeDrillEvidence(built.dir, "restore");
      const base = await built.ctx();
      const startup = { ...base.prerequisite.startup, config: { ...base.prerequisite.startup.config, generation: 2, gameTable: "gs-staging-game-g2" } };
      const gate = async (script: ReaderScript, record: Record<string, unknown> = {}) => {
        if (Object.keys(record).length > 0) {
          fs.rmSync(path.join(built.dir, "gate-generation.json"));
          writeDrillEvidence(built.dir, "restore", record);
        }
        const evidence = await generationOf(script);
        return reasons(drills.judgeGenerationGateRecord(built.dir, { environment: "staging", generation: startup.config.generation, gameTable: startup.config.gameTable, evidence, prerequisiteAt: "2026-09-30T10:00:00.000Z" }));
      };
      assert.equal(await gate({ marker: RESTORED_MARKER, appgen: ADOPTED }), "");
      const history = { generation: 2, ...(ADOPTED.adoption as NonNullable<AppGenerationFacts["adoption"]>) };
      assert.match(await gate({ marker: RESTORED_MARKER, appgen: ADOPTED, history: { ...history, claim: "33333333-3333-4333-8333-333333333333" } }), /adoption_claim = APPGEN#HISTORY\/GEN#2/, "a record whose claim the ledger's history does not hold");
      assert.match(await gate({ marker: RESTORED_MARKER, appgen: ADOPTED, history: null }), /the adoption's transaction did not land/);
      assert.match(await gate({ marker: RESTORED_MARKER, appgen: ADOPTED, history: new Error("APPGEN#HISTORY damaged") }), /unreadable/);
      assert.match(await gate({ marker: RESTORED_MARKER, appgen: ADOPTED }, { adoption_claim: "44444444-4444-4444-8444-444444444444" }), /adoption_claim/, "a hand-edited claim");
      assert.match(await gate({ marker: RESTORED_MARKER, appgen: ADOPTED }, { verdict: "CLOSED" }), /was not OPEN/);
      assert.match(await gate({ marker: RESTORED_MARKER, appgen: ADOPTED }, { environment: "prod" }), /not staging/);
      assert.match(await gate({ marker: RESTORED_MARKER, appgen: ADOPTED }, { attestation: { generation: 2, game_table: "gs-staging-game-g2b", restore_id: "drill-0930" } }), /differs from the gate's attestation in game_table/);
      assert.match(await gate({ marker: RESTORED_MARKER, appgen: ADOPTED }, { gated_at: "2026-09-30T09:00:00.000Z" }), /gated after the adoption/);
      fs.rmSync(path.join(built.dir, "gate-generation.json"));
      assert.match(await gate({ marker: RESTORED_MARKER, appgen: ADOPTED }), /the gate's own record/);
      /* The claim cross-check is read-only: the fake ledger was only read (no write seam exists on RecoveryReaders). */
      assert.deepEqual(Object.keys(readersFor()).sort(), ["adoptionRecord", "appGeneration", "generationMarker", "generationServingProblem", "identityState", "reviews"]);
    } finally {
      cleanup(built.dir);
    }
  });

  test("TASK# heartbeats: the PREVIOUS generation's table after the stop -- fresh = FAIL, none proves nothing, unreadable = FAIL, unbound = ECS alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-l6hb-"));
    try {
      const adoption = { ...(ADOPTED.adoption as NonNullable<AppGenerationFacts["adoption"]>), generation: 2 };
      write(dir, path.join(STOP_DIR, "stamp.json"), { format: RESTORE_STOP_FORMAT, run_id: RUN, restore_id: adoption.restore_id, captured_at: "2026-09-30T09:30:00Z" });
      const asked: unknown[] = [];
      const reader = (ids: readonly string[] | Error) => async (_c: unknown, table: string, expect: { generation: number; after: number }) => {
        asked.push({ table, ...expect });
        if (ids instanceof Error) throw ids;
        return ids;
      };
      const tableOf = (g: number) => `gs-staging-game-g${g}`;
      const fresh = await readRestoreHeartbeats(reader(["t-old1"]), {} as never, { dir, adoption, tableOf });
      assert.deepEqual(asked, [{ table: "gs-staging-game-g1", generation: 1, after: Date.parse("2026-09-30T09:30:00Z") }], "g<N>, generation N, after the stop's captured_at");
      const none = await readRestoreHeartbeats(reader([]), {} as never, { dir, adoption, tableOf });
      const broken = await readRestoreHeartbeats(reader(new Error("a TASK# item with an unknown role")), {} as never, { dir, adoption, tableOf });
      assert.equal(await readRestoreHeartbeats(undefined, {} as never, { dir, adoption, tableOf }), null);
      const noAdoption = await readRestoreHeartbeats(reader([]), {} as never, { dir, adoption: null, tableOf });
      fs.rmSync(path.join(dir, STOP_DIR, "stamp.json"));
      const noStamp = await readRestoreHeartbeats(reader([]), {} as never, { dir, adoption, tableOf });
      const built = await buildPackage({ generation: { marker: RESTORED_MARKER, appgen: ADOPTED } });
      try {
        write(built.dir, path.join(RESTORE_STOP_DIR, "services.json"), { services: [{ serviceName: "gs-staging-p1", status: "ACTIVE", desiredCount: 0, runningCount: 0, pendingCount: 0 }], failures: [] });
        write(built.dir, path.join(RESTORE_STOP_DIR, "cluster-tasks.json"), { batches: [{ tasks: [], failures: [] }] });
        write(built.dir, path.join(RESTORE_STOP_DIR, "stamp.json"), { format: RESTORE_STOP_FORMAT, run_id: RUN, restore_id: "drill-0930", captured_at: "2026-09-30T09:30:00Z" });
        const base = await built.ctx();
        const quiet = (heartbeats: typeof fresh) => reasons((certify({ ...base, scenario: "restore-drill", heartbeats }).gates.find((g) => g.id === "restore-quiet") as { checks: readonly Check[] }).checks);
        assert.match(quiet(fresh), /fresh heartbeats from t-old1/);
        assert.equal(quiet(none), "", "no heartbeat: the ECS stop stands (TASK# is never the authority)");
        assert.match(quiet(broken), /unreadable: the old generation's TASK# items could not be read completely/);
        assert.match(quiet(noAdoption), /APPGEN shows no adoption/);
        assert.match(quiet(noStamp), /no restore-stop time/);
      } finally {
        cleanup(built.dir);
      }
    } finally {
      cleanup(dir);
    }
  });

  /* ---------------- the flip drill (two pools; p2 -> p1) ---------------- */

  const P2_TASK = `arn:aws:ecs:us-east-1:111111111111:task/gs-staging/${"b2".repeat(16)}`;
  const TG_P2 = "arn:aws:elasticloadbalancing:us-east-1:111111111111:targetgroup/gs-staging-p2/fedcba9876543210";
  const at = (iso: string) => Date.parse(iso);
  const serviceTask = (pool: string, id: string, extra: Record<string, unknown>) => ({ taskArn: `arn:aws:ecs:us-east-1:111111111111:task/gs-staging/${id.repeat(16)}`, group: `service:gs-staging-${pool}`, taskDefinitionArn: `arn:aws:ecs:us-east-1:111111111111:task-definition/gs-staging-${pool}:7`, ...extra });
  function flipDir(over: { record?: Record<string, unknown>; stoppedExit?: Record<string, number>; alarms?: Record<string, unknown>; capture?: string; gsTo?: string; extraClusterTasks?: readonly Record<string, unknown>[] } = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-l6flip-"));
    write(dir, "flip-record.json", flipRecord(over.record ?? {}));
    const stopped = (pool: string, id: string) => serviceTask(pool, id, { lastStatus: "STOPPED", desiredStatus: "STOPPED", startedAt: "2026-09-30T08:00:00Z", stoppedAt: "2026-09-30T09:00:30Z", containers: [{ name: "game-server", exitCode: over.stoppedExit?.[pool] ?? 5 }] });
    const running = (pool: string, id: string) => serviceTask(pool, id, { lastStatus: "RUNNING", desiredStatus: "RUNNING", startedAt: "2026-09-30T09:01:00Z", containers: [{ name: "game-server", lastStatus: "RUNNING" }] });
    const tasks = { p1: [stopped("p1", "c1"), running("p1", "d1")], p2: [stopped("p2", "c2"), running("p2", "d2")] };
    for (const pool of ["p1", "p2"] as const) {
      write(dir, POOL_EVIDENCE_FILES.stoppedTasks(pool), { tasks: [tasks[pool][0]] });
      write(dir, POOL_EVIDENCE_FILES.runningTasks(pool), { tasks: [tasks[pool][1]] });
    }
    write(dir, EVIDENCE.clusterTasks, clusterListing([...tasks.p1, ...tasks.p2, ...(over.extraClusterTasks ?? [])]));
    write(dir, POOL_EVIDENCE_FILES.targetGroups, { TargetGroups: [TARGET_GROUPS.TargetGroups[0], { ...TARGET_GROUPS.TargetGroups[0], TargetGroupArn: TG_P2, TargetGroupName: "gs-staging-p2" }] });
    const gs = over.gsTo === "p2" ? TG_P2 : TG_ARN;
    write(dir, POOL_EVIDENCE_FILES.listenerRules, {
      Rules: [
        { Priority: "100", Conditions: [{ Field: "path-pattern", Values: ["/gs/p/p1"], PathPatternConfig: { Values: ["/gs/p/p1"] } }], Actions: [{ Type: "forward", TargetGroupArn: TG_ARN }] },
        { Priority: "101", Conditions: [{ Field: "path-pattern", Values: ["/gs/p/p2"], PathPatternConfig: { Values: ["/gs/p/p2"] } }], Actions: [{ Type: "forward", TargetGroupArn: TG_P2 }] },
        { Priority: "1000", Conditions: [{ Field: "path-pattern", Values: ["/gs*"], PathPatternConfig: { Values: ["/gs*"] } }], Actions: [{ Type: "forward", TargetGroupArn: gs }] },
        { Priority: "default", IsDefault: true, Conditions: [], Actions: [{ Type: "fixed-response" }] },
      ],
    });
    write(dir, EVIDENCE.capture, { format: "18COSMOS/L5-8-CAPTURE/v1", captured_at: over.capture ?? "2026-09-30T09:30:00Z" });
    write(dir, "probe-flip-alarms.json", {
      format: "18COSMOS/L6-6-FLIP-ALARM-DRILL/v1",
      run_id: RUN,
      flip: { from: "p2", to: "p1", opened_at: FLIP_WINDOW.opened_at, expires_at: FLIP_WINDOW.expires_at },
      cases: {
        "exit3-in-window-pages-a1": { task_arn: `arn:aws:ecs:us-east-1:111111111111:task/gs-staging/${"e3".repeat(16)}`, exit_code: 3, stopped_at: at("2026-09-30T09:05:00Z"), alarm: "gs-staging-a1-unexpected-task-loss", state: "ALARM", alarm_at: at("2026-09-30T09:06:00Z"), actions_suppressed: false },
        "suppressed-alarm-actionable-after-window": { alarm: "gs-staging-p1-a12-prolonged-unready", during: { at: at("2026-09-30T09:10:00Z"), composite_state: "ALARM", actions_suppressed_by: "Alarm" }, after: { at: at("2026-09-30T09:22:00Z"), composite_state: "ALARM", actions_suppressed_by: "None" } },
        "suppressors-during-window": { at: at("2026-09-30T09:10:00Z"), states: { p1: "ALARM", p2: "ALARM" } },
        ...(over.alarms ?? {}),
      },
    });
    return dir;
  }
  const FLIP_EXPECT = { environment: "staging", pools: ["p1", "p2"], primaryPool: "p1", escrow: true };
  const flipText = (dir: string) => reasons(drills.judgeFlipDrill(dir, FLIP_EXPECT));
  const flipAlarmText = (dir: string, pools = ["p1", "p2"]) => reasons(drills.judgeFlipAlarmDrill(dir, { run: RUN, environment: "staging", pools }));

  test("flip drill: L6-2's record and captures -- window before the CAS, roles settled, exit 5 only, /gs* moved, recovery settled, suppression bounded", () => {
    const ok = flipDir();
    try {
      assert.equal(flipText(ok), "");
      assert.equal(flipAlarmText(ok), "");
    } finally {
      cleanup(ok);
    }
    const cases: Array<[string, Parameters<typeof flipDir>[0], RegExp]> = [
      ["the window opened after the CAS", { record: { window: { ...FLIP_WINDOW, opened_at: FLIP_WINDOW.opened_at + 5_000, suppression: "closed" } } }, /window opened BEFORE the routing CAS/],
      ["the CAS not applied", { record: { cas: { at: FLIP_WINDOW.opened_at + 1000, run: null, outcome: "unknown", version: null, detail: "" }, verdict: "unknown" } }, /roles settled[\s\S]*CAS applied/],
      ["the roles not settled", { record: { verdict: "timeout" } }, /the roles settled/],
      ["the identity writer left on the old primary", { record: { after: { ...(flipRecord().after as object), identity_writer: { epoch: 12, pool: "p2", task: "t" } } } }, /restarted into their roles/],
      ["an exit 3 from a flip pool's service task", { stoppedExit: { p2: 3 } }, /no loss|no exit 3 \/ 4/],
      ["an exit 4 from a flip pool's service task", { stoppedExit: { p1: 4 } }, /no exit 3 \/ 4/],
      ["/gs* still on the old primary", { gsTo: "p2" }, /ALB \/gs\* rule/],
      ["the recovery never settled (window open)", { record: { window: { ...FLIP_WINDOW, closed_at: null, suppression: "published" } } }, /recovery of the superseded ownership settled/],
      ["the suppression never published", { record: { window: { ...FLIP_WINDOW, suppression: "failed" } } }, /suppression was failed/],
      ["a window longer than 45 min", { record: { window: { ...FLIP_WINDOW, expires_at: FLIP_WINDOW.opened_at + 50 * 60_000, suppression: "closed" } } }, /suppression was bounded/],
      ["captured before the window's tail ended", { capture: "2026-09-30T09:22:00Z" }, /captured before the window/],
      ["another environment's flip", { record: { environment: "prod" } }, /this environment's flip/],
      ["a rollback record (not a certifiable drill)", { record: { rollback: true } }, /a forward flip/],
    ];
    for (const [label, over, want] of cases) {
      const dir = flipDir(over);
      try {
        assert.match(flipText(dir), want, label);
      } finally {
        cleanup(dir);
      }
    }
    /* The complete listing (L6-6P) is the authority on exits, not the per-pool capture (a bounded view): a flip pool's
       SERVICE task that stopped with exit 3 in the window, seen only in the complete listing, FAILS the drill -- while the
       drill's own injected exit 3 (a STANDALONE task, group family:) does not. */
    const hiddenLoss = flipDir({ extraClusterTasks: [serviceTask("p2", "a3", { lastStatus: "STOPPED", desiredStatus: "STOPPED", startedAt: "2026-09-30T08:59:00Z", stoppedAt: "2026-09-30T09:00:10Z", containers: [{ name: "game-server", exitCode: 3 }] })] });
    const injected = flipDir({ extraClusterTasks: [{ taskArn: `arn:aws:ecs:us-east-1:111111111111:task/gs-staging/${"e3".repeat(16)}`, group: "family:gs-staging-p1", lastStatus: "STOPPED", desiredStatus: "STOPPED", stoppedAt: "2026-09-30T09:05:00Z", containers: [{ name: "game-server", exitCode: 3 }] }] });
    try {
      assert.match(flipText(hiddenLoss), /no exit 3 \/ 4 in the window \(complete cluster listing\): .*exit 3/);
      assert.equal(flipText(injected), "", "the drill's injected standalone exit 3 is not a flip pool's loss");
    } finally {
      cleanup(hiddenLoss);
      cleanup(injected);
    }
    const missing = fs.mkdtempSync(path.join(os.tmpdir(), "gs-l6flip-"));
    try {
      assert.match(flipText(missing), /L6-2's flip record/);
      assert.match(flipAlarmText(missing), /the drill's observations/);
    } finally {
      cleanup(missing);
    }
  });

  test("flip drill alarms: an exit 3 in the window still trips A1; a still-failing alarm acts after the window; only the flip's two pools suppressed", () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["no A1 observation", { "exit3-in-window-pages-a1": undefined }, /exit 3 during the flip still trips A1/],
      ["A1 never fired", { "exit3-in-window-pages-a1": { task_arn: "x", exit_code: 3, stopped_at: at("2026-09-30T09:05:00Z"), alarm: "gs-staging-a1-unexpected-task-loss", state: "OK", alarm_at: at("2026-09-30T09:06:00Z"), actions_suppressed: false } }, /trips A1/],
      ["A1's actions suppressed", { "exit3-in-window-pages-a1": { task_arn: "x", exit_code: 3, stopped_at: at("2026-09-30T09:05:00Z"), alarm: "gs-staging-a1-unexpected-task-loss", state: "ALARM", alarm_at: at("2026-09-30T09:06:00Z"), actions_suppressed: true } }, /trips A1/],
      ["the exit 3 outside the window", { "exit3-in-window-pages-a1": { task_arn: "x", exit_code: 3, stopped_at: at("2026-09-30T09:25:00Z"), alarm: "gs-staging-a1-unexpected-task-loss", state: "ALARM", alarm_at: at("2026-09-30T09:26:00Z"), actions_suppressed: false } }, /trips A1/],
      ["still suppressed after the window", { "suppressed-alarm-actionable-after-window": { alarm: "gs-staging-p1-a12-prolonged-unready", during: { at: at("2026-09-30T09:10:00Z"), composite_state: "ALARM", actions_suppressed_by: "Alarm" }, after: { at: at("2026-09-30T09:22:00Z"), composite_state: "ALARM", actions_suppressed_by: "Alarm" } } }, /actionable after the window/],
      ["an unsuppressible alarm offered as the suppressed one", { "suppressed-alarm-actionable-after-window": { alarm: "gs-staging-a1-unexpected-task-loss", during: { at: at("2026-09-30T09:10:00Z"), composite_state: "ALARM", actions_suppressed_by: "Alarm" }, after: { at: at("2026-09-30T09:22:00Z"), composite_state: "ALARM", actions_suppressed_by: "None" } } }, /actionable after the window/],
    ];
    for (const [label, alarms, want] of cases) {
      const dir = flipDir({ alarms });
      try {
        assert.match(flipAlarmText(dir), want, label);
      } finally {
        cleanup(dir);
      }
    }
    const third = flipDir({ alarms: { "suppressors-during-window": { at: at("2026-09-30T09:10:00Z"), states: { p1: "ALARM", p2: "ALARM", p3: "ALARM" } } } });
    try {
      assert.match(flipAlarmText(third, ["p1", "p2", "p3"]), /only the flip's two pools were suppressed/, "a third pool's suppressor in ALARM");
    } finally {
      cleanup(third);
    }
  });

  test("flip drill: the verifier's own flip judgement runs from the record in the evidence (L6-2's `verify --flip-record`), and the alarms gate judges suppressors in ITS window", async () => {
    const built = await buildPackage();
    try {
      writeDrillEvidence(built.dir, "flip", { from: "p2", to: "p1" });
      const record = drills.flipRecordOf(built.dir).record;
      assert.ok(record !== null);
      assert.deepEqual(drills.flipWindowOf(record), { from: "p2", to: "p1", ...FLIP_WINDOW });
      /* A suppressor in ALARM long after the window: stuck -- FAIL even inside a flip drill. */
      const doc = clone(ALARMS) as any;
      doc.MetricAlarms.find((a: any) => a.AlarmName === "gs-staging-p1-flip-window").StateValue = "ALARM";
      write(built.dir, EVIDENCE_FILES.alarms, doc);
      const gate = certify({ ...(await built.ctx()), scenario: "flip-drill" }).gates.find((g) => g.id === "alarms") as { checks: readonly Check[] };
      assert.match(reasons(gate.checks), /restored outside a window/);
      /* Judged at the time alarms.json was read (manifest.json, written right after it), never at capture.json's later
         stamp: a suppressor still in its window's 5-minute tail when the alarms were read is not "stuck". */
      write(built.dir, POOL_EVIDENCE_FILES.manifest, { format: "18COSMOS/EVIDENCE/v1", captured_at: "2026-09-30T09:22:00Z", environment: "staging", region: "us-east-1", pools: ["p1"] });
      write(built.dir, EVIDENCE.capture, { format: "18COSMOS/L5-8-CAPTURE/v1", captured_at: "2026-09-30T09:30:00Z" });
      const inTail = certify({ ...(await built.ctx()), scenario: "flip-drill" }).gates.find((g) => g.id === "alarms") as { checks: readonly Check[] };
      assert.ok(!/restored outside a window/.test(reasons(inTail.checks)), reasons(inTail.checks));
    } finally {
      cleanup(built.dir);
    }
  });

  /* ---------------- the relayer-address rotation drill ---------------- */

  test("relayer rotation: the gate OPEN with the OLD address configured, every pool drained, RELAYQ#<old> read completely and empty, the new queue never used -- and only then the change", async () => {
    const built = await buildPackage();
    try {
      const gate = async (over: Record<string, unknown> = {}, rotation = { from: RELAYER_OLD, to: relayerNew() }) => {
        fs.rmSync(path.join(built.dir, "gate-relayer-rotation.json"), { force: true });
        writeDrillEvidence(built.dir, "rotation", over);
        const g = certify({ ...(await built.ctx()), scenario: "relayer-rotation-drill", rotation }).gates.find((x) => x.id === "relayer-rotation") as { status: string; checks: readonly Check[] };
        return { status: g.status, text: reasons(g.checks) };
      };
      assert.deepEqual(await gate(), { status: "pass", text: "" });
      const checksWith = (name: string, status: string) => {
        const base = [
          { name: "the active configuration names the OLD relayer", status: "pass", detail: "" },
          { name: "drained p1", status: "pass", detail: "" },
          { name: `RELAYQ#${RELAYER_OLD} empty (strongly consistent, every page)`, status: "pass", detail: "" },
          { name: `RELAYQ#${relayerNew()}`, status: "skipped", detail: "" },
        ];
        return base.map((c) => (c.name === name ? { ...c, status } : c));
      };
      const cases: Array<[string, Record<string, unknown>, RegExp, { from: string; to: string }?]> = [
        ["a CLOSED gate", { verdict: "CLOSED" }, /was OPEN/],
        ["the old queue unknown", { queue: "unknown" }, /was unknown at the gate/],
        ["the old queue open", { queue: "open" }, /was open at the gate/],
        ["the new configuration already active at the gate", { configured_relayer: relayerNew() }, /the configuration named/],
        ["a pool not proven drained", { checks: checksWith("drained p1", "skipped") }, /every pool drained/],
        ["another deployment's pools", { pools: ["p1", "p9"] }, /every pool drained/],
        ["the old queue's check failed", { checks: checksWith(`RELAYQ#${RELAYER_OLD} empty (strongly consistent, every page)`, "fail") }, /was OPEN|read completely/],
        ["the NEW queue used to infer safety", { checks: checksWith(`RELAYQ#${relayerNew()}`, "pass") }, /never used to infer safety/],
        ["gated after the tasks restarted", { gated_at: "2026-09-30T09:30:00.000Z" }, /changed only after the gate/],
        ["another rotation's record", {}, /gates .* not /, { from: RELAYER_OLD, to: "juno1wfk5fda0sg5z2lqrpwh7wexnckpe6hqzljkt4v" }],
      ];
      for (const [label, over, want, rotation] of cases) {
        const got = await gate(over, rotation);
        assert.equal(got.status, "fail", label);
        assert.match(got.text, want, label);
      }
      /* The live configuration must name the NEW address (a gate whose change never happened certifies nothing). */
      const stale = await gate({ from_relayer: relayerNew(), to_relayer: RELAYER_OLD, configured_relayer: relayerNew(), checks: [{ name: "drained p1", status: "pass", detail: "" }, { name: `RELAYQ#${relayerNew()} empty (strongly consistent, every page)`, status: "pass", detail: "" }, { name: `RELAYQ#${RELAYER_OLD}`, status: "skipped", detail: "" }] }, { from: relayerNew(), to: RELAYER_OLD });
      assert.match(stale.text, /changed only after the gate: at the gate .*, now /);
      fs.rmSync(path.join(built.dir, "gate-relayer-rotation.json"));
      const none = certify({ ...(await built.ctx()), scenario: "relayer-rotation-drill", rotation: { from: RELAYER_OLD, to: relayerNew() } }).gates.find((x) => x.id === "relayer-rotation") as { checks: readonly Check[] };
      assert.match(reasons(none.checks), /the gate's own record/);
    } finally {
      cleanup(built.dir);
    }
  });

  /* ---------------- the restore drill's alarms ---------------- */

  test("restore alarms: R1, A4g, A4i, R2, R3 each fired under its injected condition, never suppressed -- at least one inside an overlapping flip window", async () => {
    const built = await buildPackage();
    try {
      const judged = (cases: Record<string, unknown>) => {
        const doc = JSON.parse(fs.readFileSync(path.join(built.dir, "probe-restore-alarms.json"), "utf8"));
        write(built.dir, "probe-restore-alarms.json", { ...doc, cases: { ...doc.cases, ...cases } });
        const text = reasons(drills.judgeRestoreAlarmDrill(built.dir, { run: RUN, environment: "staging", pools: ["p1"] }));
        write(built.dir, "probe-restore-alarms.json", doc);
        return text;
      };
      writeDrillEvidence(built.dir, "restore");
      assert.equal(judged({}), "");
      const good = JSON.parse(fs.readFileSync(path.join(built.dir, "probe-restore-alarms.json"), "utf8")).cases;
      assert.match(judged({ "r2-money-journal-ahead": undefined }), /r2-money-journal-ahead fires .*no observation/);
      assert.match(judged({ "a4g-generation-refused": { ...good["a4g-generation-refused"], actions_suppressed: true } }), /a4g-generation-refused fires/);
      assert.match(judged({ "a4i-identity-restore-refused": { ...good["a4i-identity-restore-refused"], state: "OK" } }), /a4i-identity-restore-refused fires/);
      assert.match(judged({ "r3-restore-unverified": { ...good["r3-restore-unverified"], alarm: "gs-staging-p9-r3-restore-unverified" } }), /r3-restore-unverified fires/, "another deployment's pool");
      assert.match(judged({ "r1-generation-lost": { ...good["r1-generation-lost"], alarm_at: good["r1-generation-lost"].injected_at - 1 } }), /r1-generation-lost fires/, "fired before the injection");
      assert.match(judged({ "r1-generation-lost": { ...good["r1-generation-lost"], overlapping_flip_window: null } }), /not suppressed by an overlapping flip window \(observed\)/);
      assert.match(judged({ "r1-generation-lost": { ...good["r1-generation-lost"], overlapping_flip_window: { ...good["r1-generation-lost"].overlapping_flip_window, opened_at: good["r1-generation-lost"].injected_at + 1 } } }), /does not cover the injection/);
    } finally {
      cleanup(built.dir);
    }
  });

  test("SOURCE GUARDS: the binding names L6-4's readers and the TASK# reader; only tools/awsDeploy.ts reaches the reader; the verifier never reads TASK# into a decision", () => {
    const SRC = path.join(REPO, "server/src");
    const tool = fs.readFileSync(path.join(SRC, "tools/awsDeploy.ts"), "utf8");
    for (const fn of ["readGenerationMarker", "readAppGeneration", "generationMarkerProblem", "adoptionBindingProblem", "readIdentityRestore", "readIdentityTableSelf", "identityServingProblem", "inspectIdentityRestore", "readAdoptionRecord", "oldGenerationHeartbeatsAfter"]) assert.match(tool, new RegExp(`\\b${fn}\\b`), fn);
    assert.match(tool, /ReviewSummary as StagingReviewSummary/, "L6-6's ReviewSummary is imported under an explicit alias (L6-4 has its own)");
    assert.match(tool, /open: r\.resolved_at === null/);
    assert.ok(!/profile_id|principal_id|unconfirmed_events|selector_state/.test(tool), "the REVIEW# mapping carries only the safe summary");
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [path.join(dir, e.name)] : []));
    const importers = walk(SRC).filter((f) => /from\s+"[^"]*runtime\/taskHeartbeats"/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(SRC, f).split(path.sep).join("/"));
    assert.deepEqual(importers, ["tools/awsDeploy.ts"]);
  });
});

/* ================================================================== */
/* LIVE-6 W1: the package on a Windows filesystem                       */
/* ================================================================== */

/**
 * A case-INSENSITIVE, case-preserving filesystem (Windows/NTFS; macOS's default APFS) under `root`, modelled over this
 * one: while it is on, a path under `root` opens the entry that already exists with that spelling IGNORING case -- as
 * Windows opens `MANIFEST.json` when `manifest.json` is there -- else the spelling given (which is then created as given).
 * The `fs` functions the evidence code calls are wrapped (every module sees them through its `fs` import); `off()`
 * restores them.
 */
function caseInsensitiveFs(root: string): { readonly off: () => void } {
  const real = require("fs") as Record<string, (...args: unknown[]) => unknown>;
  const names = ["readFileSync", "writeFileSync", "appendFileSync", "existsSync", "statSync", "lstatSync", "rmSync", "unlinkSync", "mkdirSync", "readdirSync", "openSync", "renameSync", "copyFileSync"];
  const originals = new Map(names.map((n) => [n, real[n]] as const));
  const readdir = originals.get("readdirSync") as (p: string) => string[];
  const fold = (p: unknown): unknown => {
    if (typeof p !== "string") return p;
    const abs = path.resolve(p);
    if (abs !== root && !abs.startsWith(root + path.sep)) return p;
    let at = root;
    for (const part of path.relative(root, abs).split(path.sep).filter((x) => x !== "")) {
      let entries: string[] = [];
      try {
        entries = readdir.call(real, at);
      } catch {
        entries = [];
      }
      at = path.join(at, entries.find((e) => e.toLowerCase() === part.toLowerCase()) ?? part);
    }
    return at;
  };
  for (const n of names) {
    const original = originals.get(n) as (...args: unknown[]) => unknown;
    real[n] = (...args: unknown[]) => original.apply(real, n === "renameSync" || n === "copyFileSync" ? [fold(args[0]), fold(args[1]), ...args.slice(2)] : [fold(args[0]), ...args.slice(1)]);
  }
  return { off: () => names.forEach((n) => (real[n] = originals.get(n) as (...args: unknown[]) => unknown)) };
}

/** Every evidence-relative name the harness, its scripts and the verifier read or write, for pools p1 and p2: the
 *  registries' names, and every output name the capture / drain / plan / probe scripts spell (`$OUT/x`, `Join-Path $Out "x"`). */
function packageNames(): string[] {
  const pools = ["p1", "p2"];
  const names: string[] = [];
  const add = (...n: string[]) => names.push(...n);
  const values = (o: object) => Object.values(o).filter((v): v is string => typeof v === "string");
  add(...values(EVIDENCE), ...values(EVIDENCE_FILES), ...values(POOL_EVIDENCE_FILES), ...values(require("./drills").DRILL_FILES as object));
  add(RESTORE_FENCING_FILE, PRIOR_CERTIFICATIONS, ...["services.json", "cluster-tasks.json", "stamp.json"].map((f) => evidenceName(RESTORE_STOP_DIR, f)), `${EVIDENCE.clusterTasks}.partial`);
  for (const stack of ["app", "ledger"]) add(...values(TERRAFORM_FILES).map((f) => evidenceName(EVIDENCE.terraformDir(stack), f)));
  for (const pool of pools) {
    add(EVIDENCE.drain(pool), EVIDENCE_FILES.taskDefinition(pool), revisionsFile(pool), ...values(DRAIN_FILES).map((f) => evidenceName(drainDir(pool), f)));
    for (const f of Object.values(POOL_EVIDENCE_FILES)) if (typeof f === "function") add(f(pool));
  }
  for (const script of fs.readdirSync(SCRIPTS)) {
    const text = readCheckoutText(path.join(SCRIPTS, script));
    const spelled = [
      ...[...text.matchAll(/"\$(?:OUT|DIR|EVIDENCE)\/([^"$]+(?:\$\{?pool\}?[^"$]*|\$\{POOL\}[^"$]*)?)"/g)].map((m) => m[1]),
      ...[...text.matchAll(/Join-Path \$(?:Out|dir|target) "([^"]+)"/g)].map((m) => m[1]),
      ...[...text.matchAll(/(?:Save|SaveJson|DescribeTasks) "([^"]+)"/g)].map((m) => m[1]),
    ];
    for (const name of spelled) for (const pool of pools) add(name.replace(/\$\{?pool\}?|\$\{POOL\}|\$Pool|\$pool/g, pool).replace(/\$\(\$status\.ToLower\(\)\)|\$\{lower\}/g, "stopped"));
  }
  return names;
}

describe("LIVE-6 W1: the evidence package on a Windows filesystem (case-insensitive, `\\` separators)", () => {
  test("no two names the package holds fold to one path -- the certification's manifest is not capture-evidence's", () => {
    const names = packageNames();
    assert.ok(names.includes(POOL_EVIDENCE_FILES.manifest) && names.includes(EVIDENCE.manifest), "both manifests are in the registry");
    assert.ok(names.includes("cluster-tasks.json") && names.includes("target-health-p1.json") && names.includes("drain-p1/tasks-before.json"), "the scripts' names were read");
    assert.deepEqual(caseFoldCollisions(withDirectories(names)), [], "each Windows path is claimed by one spelling");
    assert.notEqual(EVIDENCE.manifest.toLowerCase(), POOL_EVIDENCE_FILES.manifest.toLowerCase());
    /* The guard itself: the old pair is exactly what it reports; `\\` and `/` are one separator; a directory counts. */
    assert.deepEqual(caseFoldCollisions([...names, "MANIFEST.json"]), [["MANIFEST.json", "manifest.json"]]);
    assert.deepEqual(caseFoldCollisions(withDirectories(["terraform\\App\\plan.json", "terraform/app/lock.hcl"])), [["terraform/App", "terraform/app"]]);
  });

  test("evidence-relative names are `/`-separated on every platform (a Windows join's `\\` is folded)", () => {
    assert.equal(evidenceName(drainDir("p1"), DRAIN_FILES.tasksBefore), "drain-p1/tasks-before.json");
    assert.equal(evidenceName(EVIDENCE.terraformDir("app"), TERRAFORM_FILES.plan), "terraform/app/plan.json");
    assert.equal(evidenceName(path.win32.join("terraform", "app"), "plan.json"), "terraform/app/plan.json");
    assert.equal(evidenceName(path.win32.join(PRIOR_CERTIFICATIONS, "a.json")), "prior-certifications/a.json");
    assert.equal(toPosixPath(path.win32.relative("C:\\e", "C:\\e\\drain-p1\\tasks-before.json")), "drain-p1/tasks-before.json");
    /* Only ever the harness's own names: nothing that could leave the package, nothing empty. */
    for (const bad of [["..", "x.json"], ["terraform", "..", "..", "x"], ["/etc/passwd"], ["C:\\x.json"], [""], []]) assert.throws(() => evidenceName(...bad), /not an evidence-relative name/, JSON.stringify(bad));
    /* At the source: no staging module hands readEvidence a platform join (whose `\\` a Windows diagnostic would print). */
    for (const file of fs.readdirSync(__dirname.replace(`${path.sep}dist${path.sep}server${path.sep}`, `${path.sep}`)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const code = readCheckoutText(path.join(__dirname.replace(`${path.sep}dist${path.sep}server${path.sep}`, `${path.sep}`), file));
      assert.ok(!/readEvidence(?:Text)?\([^,]+,\s*path\.join\(/.test(code), `${file}: an evidence name built with path.join`);
    }
  });

  test("certify, certify again: on a case-insensitive filesystem the captured manifest.json survives, and the bytes repeat", async () => {
    const built = await buildPackage();
    const captured = fs.readFileSync(path.join(built.dir, POOL_EVIDENCE_FILES.manifest), "utf8");
    const model = caseInsensitiveFs(fs.realpathSync(built.dir));
    const dir = fs.realpathSync(built.dir);
    try {
      /* The model is real: the OLD name opens the captured manifest (this is the owner's Windows failure). */
      assert.equal(fs.readFileSync(path.join(dir, "MANIFEST.json"), "utf8"), captured, "MANIFEST.json IS manifest.json here");
      const ctx = await built.ctx({ dir });
      const first = certify(ctx);
      assert.ok(first.passed, JSON.stringify(failedGates(first).map((g) => gateFailures(first, g))));
      writeCertification(ctx, first);
      const outputs: string[] = [EVIDENCE.certification, EVIDENCE.certificationText, EVIDENCE.manifest];
      const bytes = outputs.map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
      assert.equal(fs.readFileSync(path.join(dir, POOL_EVIDENCE_FILES.manifest), "utf8"), captured, "the captured evidence is untouched");
      assert.equal(JSON.parse(captured).format, "18COSMOS/EVIDENCE/v1");
      const listed = JSON.parse(bytes[2]).files as Array<{ file: string }>;
      assert.ok(listed.some((f) => f.file === POOL_EVIDENCE_FILES.manifest), "the certification's manifest covers the captured one");
      assert.ok(listed.every((f) => !outputs.includes(f.file)), "and never itself or the verdict");
      /* A rerun: the outputs cleared (never the captured manifest), certified again from the same package. */
      clearCertification(dir);
      assert.equal(fs.readFileSync(path.join(dir, POOL_EVIDENCE_FILES.manifest), "utf8"), captured, "clearing the certification keeps the evidence");
      const again = certify(await built.ctx({ dir }));
      assert.ok(again.passed, JSON.stringify(failedGates(again)));
      writeCertification(ctx, again);
      assert.deepEqual(outputs.map((f) => fs.readFileSync(path.join(dir, f), "utf8")), bytes, "reproducible from the same evidence package");
      assert.deepEqual(manifestOf(dir).map((f) => f.file).filter((f) => f.toLowerCase() === "manifest.json"), [POOL_EVIDENCE_FILES.manifest]);
    } finally {
      model.off();
      cleanup(built.dir);
    }
  });
});
