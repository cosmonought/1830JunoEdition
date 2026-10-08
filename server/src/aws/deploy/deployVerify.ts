// server/src/aws/deploy/deployVerify.ts
//
// ==================================================================
//  LIVE-5 L5-8: DEPLOYMENT VERIFICATION -- READ-ONLY; THE LIVE ENVIRONMENT AGAINST L5-7 §14
// ==================================================================
//
// Two halves, neither of which writes anything:
//
// DATA PLANE (the SDK, through `awsClients.ts`'s factories -- the same pinned clients the runtime uses):
//   - the runtime document and (with escrow) the Juno configuration, read and checked by THE TASK'S OWN CODE
//     (`loadAwsStartup`: `parseAwsRuntimeConfigText`, `parseJunoBackendConfig` in production mode,
//     `checkEscrowConfigForAws`) -- a document the verifier accepts is one the task accepts -- and against the naming
//     contract (gs-<env>-game-g<N>, gs-<env>-identity, gs-<env>-ledger; the environment and generation asked for);
//   - the three tables: string pk HASH + sk RANGE and nothing else, on-demand, no GSI/LSI, no replicas, deletion
//     protection, ACTIVE; PITR enabled; TTL `ttl` on the identity table and (LIVE-6 L6-5B) on EVERY managed game-table
//     generation (L6-5A's diagnostic TASK# items), never on the ledger;
//   - APPGEN = the generation, SYSTEM/ROUTING = the primary pool (the bootstrap's inspection, reads only), and (L6-2, from
//     L6-4) the game table's SYSTEM/GENERATION by the task's own startup rule (`checkGenerationMarker`);
//   - with escrow: every KMS key by its key ARN is enabled, customer-managed, single-region, ECC_SECG_P256K1 /
//     SIGN_VERIFY offering ECDSA_SHA_256, and its public key is the configuration's (the relayer key controls the relayer
//     address; `checkSignerIdentities`, the backend's own check).
//
// CONTROL PLANE (pure checks over EVIDENCE: the JSON the read-only AWS CLI prints, captured by
// infra/aws/scripts/capture-evidence.{sh,ps1} -- so the server carries no ECS / ELB / CloudFront / EC2 SDK):
//   - each task definition carries references only (exactly L5-7 §14's environment names; no DATA_DIR, escrow file,
//     static credential, `secrets` or `environmentFiles`), stopTimeout 120, container health /gs/healthz, awslogs, awsvpc;
//   - each service is stop-first (0 / 100), one task, AZ rebalancing off, no ECS Exec, no public IP; (LIVE-6 L6-2) EVERY
//     pool behind ITS OWN target group, settled;
//   - (L6-2, `controlPlane/evidence.ts`) one target group per pool, /gs/readyz -> 200, each pool's target health; the
//     `/gs*` rule -> the primary's group and each pool's exact ws_path -> its own, nothing shadowed; every ACTIVE task
//     definition revision (a rollback target) declares L6-4's identity layout; after a flip, each pool's role-change
//     exit (5), its replacement running, and no loss (3/4); the capture's manifest;
//   - the ALB idle timeout >= 120 s;
//   - the distribution's /gs* behaviour is the first to match /gs paths, uncached (Managed-CachingDisabled), and its
//     origin request policy forwards ALL query strings (cp, cr, cb), all cookies, Origin and the WebSocket headers;
//   - the task security group admits the container port from the ALB's security group and nothing else;
//   - (LIVE-6 L6-5B, `controlPlane/alarmContract.ts`) the CloudWatch alarms against alarm-contract.json: every alarm,
//     its metrics / math / dimensions / thresholds / evaluation / missing data, the page / ticket wiring class, the
//     primary-only scope, the flip suppression (composites, suppressors, none in ALARM outside a window), no alarm muted,
//     nothing outside the contract.
//
// Every check is reported (name, ok, detail); nothing is skipped silently: a part the caller did not ask for is reported
// "skipped" by name, and a missing evidence file is a failure.

import { conductReviewersFromEnv } from "../../conduct/conductHttpApi";
import * as fs from "fs";
import * as path from "path";

import { DescribeContinuousBackupsCommand, DescribeTableCommand, DescribeTimeToLiveCommand, type DynamoDBClient, type TableDescription } from "@aws-sdk/client-dynamodb";
import { DescribeKeyCommand, ListGrantsCommand, type KMSClient } from "@aws-sdk/client-kms";

import { compressedKeyFromSpki, type KmsClient } from "../../escrow/juno/signer";
import { checkSignerIdentities, settlementKeyConfigOf, type JunoBackendConfig, type SignerRef } from "../../escrow/juno/junoConfig";
import { deadline } from "../awsClients";
import { KMS_KEY_SPEC, KMS_KEY_USAGE, KMS_SIGNING_ALGORITHM } from "../kms/kmsDigestClient";
import type { AwsRuntimeConfig } from "../runtime/runtimeConfig";
import { adoptionBindingProblem, generationMarkerProblem, GenerationMarkerUnreadableError, readGenerationMarker, type GenerationMarker } from "../game/generationMarker";
import { readAppGeneration } from "../ledger/appGeneration";
import { appgenState, routingState, type BootstrapClients, type RecordState } from "./bootstrap";
import {
  checkIdentityLayout,
  checkManifest,
  checkPoolListenerRules,
  checkPoolServices,
  checkPoolTargetGroups,
  checkRoleChange,
  checkTargetHealth,
  POOL_EVIDENCE_FILES,
  readRevisions,
  serviceOf as poolServiceOf,
} from "../controlPlane/evidence";
import { checkAlarmsEvidence, type FlipWindowFacts } from "../controlPlane/alarmContract";

export interface Check {
  readonly name: string;
  /** COST-2A: `not-evaluated` -- the evidence for it could not be read; never a pass (the host topologies' third answer;
   *  the ECS topology's checks never produce it). */
  readonly status: "pass" | "fail" | "skipped" | "not-evaluated";
  readonly detail: string;
}

const pass = (name: string, detail: string): Check => ({ name, status: "pass", detail });
const fail = (name: string, detail: string): Check => ({ name, status: "fail", detail });
const judge = (name: string, ok: boolean, good: string, bad: string): Check => (ok ? pass(name, good) : fail(name, bad));
export const skipped = (name: string, detail: string): Check => ({ name, status: "skipped", detail });

const describeError = (error: unknown): string => `${(error as { name?: string } | null)?.name ?? "Error"}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);

/** The published id of AWS's managed CachingDisabled cache policy (the same in every account). */
export const CACHING_DISABLED_POLICY_ID = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";

/** L5-7 §14: the task's environment, exactly (ESCROW_MONEY_TABLES only as the non-mainnet staging switch; LIVE-6 L6-6:
 *  GS_EDGE_DIAGNOSTIC only as the staging certification's edge mirror, `staging`). */
export const TASK_ENVIRONMENT_REQUIRED: readonly string[] = Object.freeze(["GS_MODE", "GS_STORAGE", "GS_AWS_CONFIG_PARAMETER", "BUILD_ID", "PORT", "GS_ALLOWED_ORIGINS", "GS_TRUSTED_PROXY_HOPS"]);
/** Phase 3 (P3-N035): GS_CONDUCT_REVIEWERS -- the usernames that may review conduct reports (a list of usernames, no secret). */
export const TASK_ENVIRONMENT_OPTIONAL: readonly string[] = Object.freeze(["ESCROW_MONEY_TABLES", "GS_EDGE_DIAGNOSTIC", "GS_CONDUCT_REVIEWERS"]);
export const TASK_ENVIRONMENT_FORBIDDEN: readonly string[] = Object.freeze(["DATA_DIR", "ESCROW_JUNO_CONFIG", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]);

/* ------------------------------------------------------------------ */
/* Names                                                                */
/* ------------------------------------------------------------------ */

export const expectedNames = (environment: string, generation: number) => ({
  gameTable: `gs-${environment}-game-g${generation}`,
  identityTable: `gs-${environment}-identity`,
  ledgerTable: `gs-${environment}-ledger`,
  taskRole: `gs-${environment}-app-task`,
  cluster: `gs-${environment}`,
  service: (pool: string) => `gs-${environment}-${pool}`,
  taskSecurityGroup: `gs-${environment}-task`,
  albSecurityGroup: `gs-${environment}-alb`,
});

/** The runtime document against the naming contract and what the caller asked for. */
export function checkRuntimeDocument(config: AwsRuntimeConfig, expect: { readonly environment: string; readonly generation: number; readonly pool: string }): Check[] {
  const names = expectedNames(expect.environment, expect.generation);
  return [
    judge("runtime document: environment", config.environment === expect.environment, config.environment, `the document is for ${config.environment}, not ${expect.environment}`),
    judge("runtime document: generation", config.generation === expect.generation, String(config.generation), `the document is for generation ${config.generation}, not ${expect.generation}`),
    judge("runtime document: pool", config.pool === expect.pool, config.pool, `the document is pool ${config.pool}'s, not ${expect.pool}'s`),
    judge("runtime document: game table", config.gameTable === names.gameTable, config.gameTable, `${config.gameTable} is not ${names.gameTable}`),
    judge("runtime document: identity table", config.identityTable === names.identityTable, config.identityTable, `${config.identityTable} is not ${names.identityTable}`),
    judge("runtime document: ledger table", config.ledger.table === names.ledgerTable, config.ledger.arn, `${config.ledger.arn} does not name ${names.ledgerTable}`),
  ];
}

/* ------------------------------------------------------------------ */
/* Tables                                                               */
/* ------------------------------------------------------------------ */

export interface TableEvidence {
  readonly table: TableDescription | null;
  /** DescribeContinuousBackups' point-in-time recovery status, or why it could not be read. */
  readonly pitr: { readonly status: string | null } | { readonly error: string };
  /** DescribeTimeToLive's status and attribute, or why it could not be read. */
  readonly ttl: { readonly status: string | null; readonly attribute: string | null } | { readonly error: string };
  readonly error?: string;
}

/** One table's description, judged (pure). `ttlAttribute`: the identity table's `ttl`; null: TTL must be off. */
export function checkTable(label: string, evidence: TableEvidence, expect: { readonly name: string; readonly ttlAttribute: string | null }): Check[] {
  const t = evidence.table;
  if (t === null) return [fail(`${label}: exists`, evidence.error ?? "DescribeTable answered no table")];
  const keys = (t.KeySchema ?? []).map((k) => `${k.AttributeName}:${k.KeyType}`).sort().join(",");
  const attributes = (t.AttributeDefinitions ?? []).map((a) => `${a.AttributeName}:${a.AttributeType}`).sort().join(",");
  const checks: Check[] = [
    judge(`${label}: name`, t.TableName === expect.name, String(t.TableName), `${t.TableName} is not ${expect.name}`),
    judge(`${label}: active`, t.TableStatus === "ACTIVE", String(t.TableStatus), `status ${t.TableStatus}`),
    judge(`${label}: keys`, keys === "pk:HASH,sk:RANGE" && attributes === "pk:S,sk:S", "string pk HASH + string sk RANGE", `keys [${keys}], attributes [${attributes}]`),
    judge(`${label}: on-demand`, t.BillingModeSummary?.BillingMode === "PAY_PER_REQUEST", "PAY_PER_REQUEST", `billing ${t.BillingModeSummary?.BillingMode ?? "PROVISIONED (no summary)"}`),
    judge(`${label}: no secondary index`, (t.GlobalSecondaryIndexes ?? []).length === 0 && (t.LocalSecondaryIndexes ?? []).length === 0, "none", "a GSI or LSI exists"),
    judge(`${label}: not a Global Table`, (t.Replicas ?? []).length === 0, "no replicas", `${(t.Replicas ?? []).length} replica(s)`),
    judge(`${label}: deletion protection`, t.DeletionProtectionEnabled === true, "enabled", "deletion protection is off"),
  ];
  if ("error" in evidence.pitr) checks.push(fail(`${label}: PITR`, `could not be read (${evidence.pitr.error})`));
  else checks.push(judge(`${label}: PITR`, evidence.pitr.status === "ENABLED", "ENABLED", `point-in-time recovery is ${evidence.pitr.status ?? "unknown"}`));
  if ("error" in evidence.ttl) checks.push(fail(`${label}: TTL`, `could not be read (${evidence.ttl.error})`));
  else if (expect.ttlAttribute === null) checks.push(judge(`${label}: TTL`, evidence.ttl.status === "DISABLED" || evidence.ttl.status === null, "off", `TTL is ${evidence.ttl.status} on ${evidence.ttl.attribute} (no item of this table may expire)`));
  else checks.push(judge(`${label}: TTL`, evidence.ttl.status === "ENABLED" && evidence.ttl.attribute === expect.ttlAttribute, `ENABLED on ${expect.ttlAttribute}`, `TTL is ${evidence.ttl.status} on ${evidence.ttl.attribute}, not ENABLED on ${expect.ttlAttribute}`));
  return checks;
}

/** Reads one table's description (DescribeTable, DescribeContinuousBackups, DescribeTimeToLive); never throws. */
export async function readTableEvidence(client: DynamoDBClient, table: string, parts: { readonly backupsAndTtl: boolean }): Promise<TableEvidence> {
  let description: TableDescription | null = null;
  try {
    description = (await client.send(new DescribeTableCommand({ TableName: table }), { abortSignal: deadline() })).Table ?? null;
  } catch (error) {
    return { table: null, pitr: { error: "not read" }, ttl: { error: "not read" }, error: describeError(error) };
  }
  if (!parts.backupsAndTtl) return { table: description, pitr: { error: "not readable across accounts (run --part ledger with the ledger account's credentials)" }, ttl: { error: "not readable across accounts (run --part ledger with the ledger account's credentials)" } };
  let pitr: TableEvidence["pitr"];
  try {
    const answer = await client.send(new DescribeContinuousBackupsCommand({ TableName: table }), { abortSignal: deadline() });
    pitr = { status: answer.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus ?? null };
  } catch (error) {
    pitr = { error: describeError(error) };
  }
  let ttl: TableEvidence["ttl"];
  try {
    const answer = await client.send(new DescribeTimeToLiveCommand({ TableName: table }), { abortSignal: deadline() });
    ttl = { status: answer.TimeToLiveDescription?.TimeToLiveStatus ?? null, attribute: answer.TimeToLiveDescription?.AttributeName ?? null };
  } catch (error) {
    ttl = { error: describeError(error) };
  }
  return { table: description, pitr, ttl };
}

/* ------------------------------------------------------------------ */
/* APPGEN and SYSTEM/ROUTING                                            */
/* ------------------------------------------------------------------ */

/**
 * LIVE-6 L6-2 (L6-4 §12.1 item 1): the game table's SYSTEM/GENERATION judged by EXACTLY the rule a task applies before it
 * takes its pool (L6-4's `generationMarkerProblem` then `adoptionBindingProblem`, over its strict readers) -- a bootstrap
 * table while APPGEN was never adopted, or the adopted restore's table after an adoption. Never a second schema.
 */
export async function checkGenerationMarker(clients: BootstrapClients, target: { readonly gameTable: string; readonly gameTableName?: string; readonly ledgerTable: string; readonly generation: number }): Promise<Check> {
  const label = "SYSTEM/GENERATION";
  const name = target.gameTableName ?? target.gameTable;
  let marker: GenerationMarker | null;
  try {
    marker = await readGenerationMarker(clients.app, target.gameTable);
  } catch (error) {
    return fail(label, error instanceof GenerationMarkerUnreadableError ? `unreadable: ${error.message}` : `could not be read (${describeError(error)})`);
  }
  const problem = generationMarkerProblem(marker, { generation: target.generation, gameTable: name });
  if (problem !== null) return fail(label, marker === null ? `${problem}: run the bootstrap` : problem);
  let appgen;
  try {
    appgen = await readAppGeneration(clients.ledger, target.ledgerTable);
  } catch (error) {
    return fail(label, `the ledger's APPGEN (its adoption binding) could not be read (${describeError(error)})`);
  }
  if (appgen === null || appgen.current_generation !== target.generation) return fail(label, `APPGEN is ${appgen === null ? "absent" : `at generation ${appgen.current_generation}`}, not ${target.generation}: no task would start`);
  const m = marker as GenerationMarker;
  const binding = adoptionBindingProblem(m, appgen.adoption === null ? null : { game_table: appgen.adoption.game_table, restore_id: appgen.adoption.restore_id });
  return binding === null ? pass(label, `generation ${m.generation}, ${m.game_table}, origin ${m.origin}${m.origin === "restore" ? ` (restore ${m.restore_id}, adopted)` : ""}`) : fail(label, binding);
}

export async function checkControlRecords(
  clients: BootstrapClients,
  target: { readonly gameTable: string; readonly gameTableName?: string; readonly ledgerTable: string; readonly primaryPool: string; readonly generation: number },
  parts: { readonly appgen: boolean; readonly routing: boolean; readonly generation?: boolean },
): Promise<Check[]> {
  const checks: Check[] = [];
  const judgeState = (label: string, read: () => Promise<RecordState>, want: string) =>
    read().then(
      (s) => (s.kind === "matches" ? pass(label, s.detail) : fail(label, s.kind === "absent" ? `absent: run the bootstrap (${want})` : s.detail)),
      (error) => fail(label, `could not be read (${describeError(error)})`),
    );
  if (parts.appgen) checks.push(await judgeState("APPGEN", () => appgenState(clients, target), `generation ${target.generation}`));
  if (parts.routing) checks.push(await judgeState("SYSTEM/ROUTING", () => routingState(clients, target), `primary pool ${target.primaryPool}`));
  if (parts.generation === true) checks.push(await checkGenerationMarker(clients, target));
  return checks;
}

/* ------------------------------------------------------------------ */
/* KMS                                                                  */
/* ------------------------------------------------------------------ */

export interface KeyDescription {
  readonly Arn?: string;
  readonly KeyState?: string;
  readonly KeySpec?: string;
  readonly KeyUsage?: string;
  readonly KeyManager?: string;
  readonly MultiRegion?: boolean;
  readonly SigningAlgorithms?: readonly string[];
}

export interface KeyReader {
  describe(arn: string): Promise<KeyDescription>;
  /** How many grants the key carries (a grant hands out Sign without appearing in the key policy). */
  grantCount(arn: string): Promise<number>;
  /** The DER SubjectPublicKeyInfo through `kmsDigestClient` (which itself checks the spec, usage and algorithm). */
  readonly digest: KmsClient;
}

/** DescribeKey through a client made by `createKmsClient` (the verifier's only use of the KMS SDK beyond the digest client). */
export function kmsKeyReader(client: KMSClient, digest: KmsClient): KeyReader {
  return {
    async describe(arn) {
      const answer = await client.send(new DescribeKeyCommand({ KeyId: arn }), { abortSignal: deadline() });
      return (answer.KeyMetadata ?? {}) as KeyDescription;
    },
    async grantCount(arn) {
      let count = 0;
      let marker: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const answer = await client.send(new ListGrantsCommand({ KeyId: arn, ...(marker === undefined ? {} : { Marker: marker }) }), { abortSignal: deadline() });
        count += (answer.Grants ?? []).length;
        if (answer.Truncated !== true || answer.NextMarker === undefined) return count;
        marker = answer.NextMarker;
      }
      return count;
    },
    digest,
  };
}

/** The escrow configuration's three keys -- and (Phase 3 escrow 2.1) its dedicated REMEDY key when it names one: their
 *  metadata, no grants, and their public keys against the configuration. */
export async function checkSigningKeys(config: JunoBackendConfig, reader: KeyReader): Promise<Check[]> {
  const checks: Check[] = [];
  const refs: ReadonlyArray<readonly [string, SignerRef]> = [
    ["relayer", config.relayer.signer],
    ["settlement", config.settlementKey.signer],
    ["admission", config.admissionKey.signer],
    ...(config.remedyKey !== null ? [["remedy", config.remedyKey.signer] as const] : []),
  ];
  const publicKeys = new Map<string, Buffer>();
  for (const [purpose, signer] of refs) {
    const label = `KMS ${purpose} key`;
    if (signer.kind !== "kms") {
      checks.push(fail(label, `a ${signer.kind} signer (AWS storage signs only with KMS keys)`));
      continue;
    }
    try {
      const d = await reader.describe(signer.key_ref);
      const problems = [
        d.Arn === signer.key_ref ? null : `DescribeKey names ${d.Arn}, not ${signer.key_ref}`,
        d.KeyState === "Enabled" ? null : `state ${d.KeyState}`,
        d.KeySpec === KMS_KEY_SPEC ? null : `spec ${d.KeySpec}`,
        d.KeyUsage === KMS_KEY_USAGE ? null : `usage ${d.KeyUsage}`,
        (d.SigningAlgorithms ?? []).includes(KMS_SIGNING_ALGORITHM) ? null : `no ${KMS_SIGNING_ALGORITHM}`,
        d.KeyManager === "CUSTOMER" ? null : `key manager ${d.KeyManager}`,
        d.MultiRegion === false ? null : "a multi-region key",
      ].filter((p): p is string => p !== null);
      checks.push(judge(`${label}: metadata`, problems.length === 0, `${signer.key_ref}: Enabled, ${KMS_KEY_SPEC}, ${KMS_KEY_USAGE}`, problems.join("; ")));
      const grants = await reader.grantCount(signer.key_ref);
      checks.push(judge(`${label}: no grants`, grants === 0, "none (only the key policy's task role signs)", `${grants} grant(s): a grant can hand out kms:Sign without appearing in the key policy`));
      publicKeys.set(purpose, compressedKeyFromSpki(await reader.digest.getPublicKey(signer.key_ref)));
    } catch (error) {
      checks.push(fail(`${label}`, `could not be read (${describeError(error)})`));
    }
  }
  const relayer = publicKeys.get("relayer");
  const settlement = publicKeys.get("settlement");
  const admission = publicKeys.get("admission");
  const remedy = config.remedyKey === null ? null : (publicKeys.get("remedy") ?? undefined);
  if (relayer === undefined || settlement === undefined || admission === undefined || remedy === undefined || config.settlementKey.signer.kind !== "kms") {
    checks.push(fail("KMS public keys = the configuration's", "not every key could be read"));
    return checks;
  }
  try {
    checkSignerIdentities(config, relayer, settlement, settlementKeyConfigOf(config, config.settlementKey.signer.key_ref), admission, remedy);
    checks.push(pass("KMS public keys = the configuration's", `the relayer key controls ${config.relayer.address}; the settlement and admission keys are the configured public keys${remedy === null ? "; no remedy key is configured (timed money refused: fail closed)" : "; the dedicated remedy key is the configured remedy public key"}`));
  } catch (error) {
    checks.push(fail("KMS public keys = the configuration's", error instanceof Error ? error.message : String(error)));
  }
  return checks;
}

/* ------------------------------------------------------------------ */
/* Control-plane evidence (pure)                                        */
/* ------------------------------------------------------------------ */

type Json = unknown;
const obj = (value: Json): Record<string, Json> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, Json>) : {});
const arr = (value: Json): Json[] => (Array.isArray(value) ? value : []);
const str = (value: Json): string | null => (typeof value === "string" ? value : null);

/** One task definition (`aws ecs describe-task-definition` output). */
export function checkTaskDefinitionEvidence(pool: string, doc: Json, expect: { readonly environment: string; readonly runtimeParameterArn: string; readonly port: number }): Check[] {
  const label = `task definition ${pool}`;
  const td = obj(obj(doc).taskDefinition);
  const containers = arr(td.containerDefinitions).map(obj);
  if (containers.length === 0) return [fail(`${label}: exists`, "no container definitions in the evidence")];
  const checks: Check[] = [];
  const game = containers.find((c) => c.name === "game-server") ?? null;
  checks.push(judge(`${label}: one container`, containers.length === 1 && game !== null, "game-server", `containers [${containers.map((c) => String(c.name)).join(", ")}]`));
  const everyName = containers.flatMap((c) => arr(c.environment).map((e) => String(obj(e).name)));
  const forbidden = TASK_ENVIRONMENT_FORBIDDEN.filter((name) => everyName.includes(name));
  checks.push(judge(`${label}: no forbidden variable`, forbidden.length === 0, "no DATA_DIR, ESCROW_JUNO_CONFIG or static AWS credential", `set: ${forbidden.join(", ")}`));
  const injected = containers.filter((c) => arr(c.secrets).length > 0 || arr(c.environmentFiles).length > 0).map((c) => String(c.name));
  checks.push(judge(`${label}: no secret injection`, injected.length === 0, "no `secrets` / `environmentFiles`", `injected into ${injected.join(", ")}`));
  if (game === null) return checks;
  const env = new Map(arr(game.environment).map((e) => [String(obj(e).name), String(obj(e).value)] as const));
  const unknown = [...env.keys()].filter((name) => !TASK_ENVIRONMENT_REQUIRED.includes(name) && !TASK_ENVIRONMENT_OPTIONAL.includes(name));
  const missing = TASK_ENVIRONMENT_REQUIRED.filter((name) => !env.has(name));
  checks.push(judge(`${label}: environment names`, unknown.length === 0 && missing.length === 0, TASK_ENVIRONMENT_REQUIRED.join(", "), `unexpected [${unknown.join(", ")}], missing [${missing.join(", ")}]`));
  const values = [
    env.get("GS_MODE") === "production" ? null : `GS_MODE=${env.get("GS_MODE")}`,
    env.get("GS_STORAGE") === "aws" ? null : `GS_STORAGE=${env.get("GS_STORAGE")}`,
    env.get("GS_AWS_CONFIG_PARAMETER") === expect.runtimeParameterArn ? null : `GS_AWS_CONFIG_PARAMETER=${env.get("GS_AWS_CONFIG_PARAMETER")} (expected ${expect.runtimeParameterArn})`,
    env.get("PORT") === String(expect.port) ? null : `PORT=${env.get("PORT")} (the container port is ${expect.port})`,
    !env.has("ESCROW_MONEY_TABLES") || env.get("ESCROW_MONEY_TABLES") === "nonmainnet" ? null : `ESCROW_MONEY_TABLES=${env.get("ESCROW_MONEY_TABLES")}`,
    !env.has("GS_EDGE_DIAGNOSTIC") || (env.get("GS_EDGE_DIAGNOSTIC") === "staging" && !/^prod/.test(expect.environment)) ? null : `GS_EDGE_DIAGNOSTIC=${env.get("GS_EDGE_DIAGNOSTIC")} (the staging edge mirror; never in ${expect.environment})`,
    !env.has("GS_CONDUCT_REVIEWERS") || conductReviewersFromEnv({ GS_CONDUCT_REVIEWERS: env.get("GS_CONDUCT_REVIEWERS") }).ok ? null : "GS_CONDUCT_REVIEWERS is not a list of usernames",
  ].filter((p): p is string => p !== null);
  checks.push(judge(`${label}: environment values`, values.length === 0, "production, aws, this pool's runtime document", values.join("; ")));
  const ports = arr(game.portMappings).map((p) => obj(p).containerPort);
  checks.push(judge(`${label}: port`, ports.length === 1 && ports[0] === expect.port, String(expect.port), `port mappings [${ports.join(", ")}]`));
  checks.push(judge(`${label}: stopTimeout`, game.stopTimeout === 120, "120 s", `stopTimeout ${String(game.stopTimeout)}`));
  const health = arr(obj(game.healthCheck).command).map(String).join(" ");
  checks.push(judge(`${label}: container health`, health.includes("/gs/healthz") && !health.includes("/gs/readyz"), "/gs/healthz", `health check "${health}"`));
  checks.push(judge(`${label}: awslogs`, obj(game.logConfiguration).logDriver === "awslogs", "awslogs", `log driver ${String(obj(game.logConfiguration).logDriver)}`));
  checks.push(judge(`${label}: awsvpc`, td.networkMode === "awsvpc", "awsvpc", `network mode ${String(td.networkMode)}`));
  const role = str(td.taskRoleArn) ?? "";
  checks.push(judge(`${label}: task role`, role.endsWith(`:role/${expectedNames(expect.environment, 1).taskRole}`), role, `task role ${role || "(none)"}`));
  return checks;
}

/** The services (`aws ecs describe-services` output). */
export function checkServicesEvidence(doc: Json, expect: { readonly environment: string; readonly pools: readonly string[]; readonly primaryPool: string }): Check[] {
  const names = expectedNames(expect.environment, 1);
  const services = arr(obj(doc).services).map(obj);
  const checks: Check[] = [];
  for (const pool of expect.pools) {
    const label = `service ${names.service(pool)}`;
    const s = services.find((x) => x.serviceName === names.service(pool));
    if (s === undefined) {
      checks.push(fail(`${label}: exists`, "not in the evidence"));
      continue;
    }
    const dc = obj(s.deploymentConfiguration);
    checks.push(judge(`${label}: stop-first`, dc.minimumHealthyPercent === 0 && dc.maximumPercent === 100, "minimumHealthyPercent 0 / maximumPercent 100", `minimumHealthyPercent ${String(dc.minimumHealthyPercent)} / maximumPercent ${String(dc.maximumPercent)} (two tasks of one pool fence each other)`));
    checks.push(judge(`${label}: one task`, typeof s.desiredCount === "number" && s.desiredCount <= 1, `desired ${String(s.desiredCount)}`, `desired ${String(s.desiredCount)}`));
    checks.push(judge(`${label}: AZ rebalancing off`, s.availabilityZoneRebalancing === "DISABLED", "DISABLED", `availabilityZoneRebalancing ${String(s.availabilityZoneRebalancing)} (it starts a task before stopping one)`));
    checks.push(judge(`${label}: no ECS Exec`, s.enableExecuteCommand !== true, "off", "ECS Exec is on"));
    const publicIp = obj(obj(s.networkConfiguration).awsvpcConfiguration).assignPublicIp;
    checks.push(judge(`${label}: no public IP`, publicIp === "DISABLED", "DISABLED", `assignPublicIp ${String(publicIp)}`));
    const breaker = obj(dc.deploymentCircuitBreaker);
    checks.push(judge(`${label}: circuit breaker`, breaker.enable === true && breaker.rollback === true, "enabled, rolls back", `circuit breaker ${JSON.stringify(breaker)}`));
    const running = str(s.taskDefinition);
    const deploying = arr(s.deployments).map((d) => str(obj(d).taskDefinition)).filter((t) => t !== running);
    checks.push(judge(`${label}: settled`, running !== null && deploying.length === 0, `running ${running}`, deploying.length > 0 ? `a deployment is in progress (${deploying.join(", ")}): verify once it settles` : "no task definition"));
    /* LIVE-6 L6-2: EVERY pool is behind one target group -- its own (`controlPlane/evidence.ts` checks which): L6-1's
       non-primary router answers readiness 200, so L5-8's "only the primary behind the ALB" no longer holds. */
    const balancers = arr(s.loadBalancers);
    checks.push(judge(`${label}: load balancer`, balancers.length === 1, `one target group${pool === expect.primaryPool ? " (the primary's)" : " (a non-primary router's own)"}`, `${balancers.length} load balancer(s)`));
  }
  return checks;
}

/** The target group (`aws elbv2 describe-target-groups` output). */
export function checkTargetGroupEvidence(doc: Json): Check[] {
  const groups = arr(obj(doc).TargetGroups).map(obj);
  if (groups.length !== 1) return [fail("target group", `${groups.length} target groups in the evidence (expected the primary's)`)];
  const g = groups[0];
  return [
    judge("target group: health path", g.HealthCheckPath === "/gs/readyz", "/gs/readyz", `health check path ${String(g.HealthCheckPath)} (readiness, not liveness)`),
    judge("target group: healthy = 200", obj(g.Matcher).HttpCode === "200", "200", `matcher ${String(obj(g.Matcher).HttpCode)}`),
    judge("target group: ip targets", g.TargetType === "ip", "ip", `target type ${String(g.TargetType)}`),
  ];
}

/** The ALB's attributes (`aws elbv2 describe-load-balancer-attributes` output). */
export function checkLoadBalancerEvidence(doc: Json): Check[] {
  const idle = arr(obj(doc).Attributes).map(obj).find((a) => a.Key === "idle_timeout.timeout_seconds");
  const seconds = Number(idle?.Value);
  return [judge("ALB idle timeout", Number.isFinite(seconds) && seconds >= 120, `${seconds} s`, `idle timeout ${String(idle?.Value)} (WebSockets need >= 120 s)`)];
}

/** CloudFront's path-pattern match (`*` any run, `?` one character; case-sensitive). */
export function cloudFrontPatternMatches(pattern: string, pathname: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return re.test(pathname) || re.test(pathname.replace(/^\//, ""));
}

const GS_PATHS = ["/gs", "/gs/", "/gs/healthz", "/gs/api/session", "/gs/ws"];
const WEBSOCKET_HEADERS = ["Sec-WebSocket-Key", "Sec-WebSocket-Version"];

/** The distribution (`aws cloudfront get-distribution-config`) and its /gs* origin request policy (`get-origin-request-policy`). */
export function checkEdgeEvidence(distribution: Json, originRequestPolicy: Json): Check[] {
  const config = obj(obj(distribution).DistributionConfig);
  const behaviors = arr(obj(config.CacheBehaviors).Items).map(obj);
  const checks: Check[] = [];
  const gs = behaviors.filter((b) => b.PathPattern === "/gs*");
  if (gs.length !== 1) return [fail("edge: /gs* behaviour", `${gs.length} behaviours with the path pattern /gs*`)];
  const behavior = gs[0];
  const shadowing = GS_PATHS.map((p) => ({ p, first: behaviors.find((b) => cloudFrontPatternMatches(String(b.PathPattern), p)) })).filter((x) => x.first !== behavior);
  checks.push(judge("edge: /gs* matches first", shadowing.length === 0, `first for ${GS_PATHS.join(", ")}`, shadowing.map((x) => `${x.p} is taken by ${String(x.first?.PathPattern ?? "the default behaviour")}`).join("; ")));
  checks.push(judge("edge: /gs* uncached", behavior.CachePolicyId === CACHING_DISABLED_POLICY_ID, "Managed-CachingDisabled", `cache policy ${String(behavior.CachePolicyId ?? "(legacy ForwardedValues)")}`));
  const methods = arr(obj(behavior.AllowedMethods).Items).map(String);
  checks.push(judge("edge: /gs* methods", ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"].every((m) => methods.includes(m)), "all seven", `allowed [${methods.join(", ")}]`));
  checks.push(judge("edge: /gs* https", behavior.ViewerProtocolPolicy === "https-only" || behavior.ViewerProtocolPolicy === "redirect-to-https", String(behavior.ViewerProtocolPolicy), `viewer protocol ${String(behavior.ViewerProtocolPolicy)}`));
  const origin = arr(obj(config.Origins).Items).map(obj).find((o) => o.Id === behavior.TargetOriginId);
  const originProtocol = obj(origin?.CustomOriginConfig).OriginProtocolPolicy;
  checks.push(judge("edge: /gs* origin over https", originProtocol === "https-only", `${String(origin?.DomainName)} https-only`, `origin ${String(behavior.TargetOriginId)} protocol ${String(originProtocol)}`));

  const policy = obj(obj(originRequestPolicy).OriginRequestPolicy);
  checks.push(judge("edge: /gs* origin request policy", behavior.OriginRequestPolicyId !== undefined && behavior.OriginRequestPolicyId === policy.Id, String(policy.Id), `the behaviour uses ${String(behavior.OriginRequestPolicyId)}, the evidence is ${String(policy.Id)}`));
  const pc = obj(policy.OriginRequestPolicyConfig);
  const qs = obj(pc.QueryStringsConfig);
  checks.push(judge("edge: ALL query strings forwarded", qs.QueryStringBehavior === "all", "all (cp, cr, cb and any later field, unchanged)", `query strings: ${String(qs.QueryStringBehavior)} -- a stripped or narrowed announcement makes a current client read as protocol 0`));
  const cookies = obj(pc.CookiesConfig).CookieBehavior;
  checks.push(judge("edge: cookies forwarded", cookies === "all", "all", `cookies: ${String(cookies)}`));
  const hc = obj(pc.HeadersConfig);
  const headers = arr(obj(hc.Headers).Items).map((h) => String(h).toLowerCase());
  const allViewer = hc.HeaderBehavior === "allViewer" || hc.HeaderBehavior === "allViewerAndWhitelistCloudFront";
  const needed = ["Origin", ...WEBSOCKET_HEADERS].filter((h) => !allViewer && !headers.includes(h.toLowerCase()));
  checks.push(judge("edge: Origin + WebSocket headers forwarded", needed.length === 0, allViewer ? String(hc.HeaderBehavior) : "Origin, Sec-WebSocket-Key, Sec-WebSocket-Version", `missing ${needed.join(", ")}`));
  return checks;
}

/** The task security group (`aws ec2 describe-security-groups` output holding the task and ALB groups). */
export function checkSecurityGroupsEvidence(doc: Json, expect: { readonly environment: string; readonly port: number }): Check[] {
  const names = expectedNames(expect.environment, 1);
  const groups = arr(obj(doc).SecurityGroups).map(obj);
  const task = groups.find((g) => g.GroupName === names.taskSecurityGroup);
  const alb = groups.find((g) => g.GroupName === names.albSecurityGroup);
  if (task === undefined || alb === undefined) return [fail("task security group", `the evidence must hold ${names.taskSecurityGroup} and ${names.albSecurityGroup}`)];
  const permissions = arr(task.IpPermissions).map(obj);
  const problems: string[] = [];
  if (permissions.length !== 1) problems.push(`${permissions.length} ingress permissions`);
  for (const p of permissions) {
    if (p.IpProtocol !== "tcp" || p.FromPort !== expect.port || p.ToPort !== expect.port) problems.push(`ingress ${String(p.IpProtocol)} ${String(p.FromPort)}-${String(p.ToPort)}`);
    if (arr(p.IpRanges).length > 0 || arr(p.Ipv6Ranges).length > 0 || arr(p.PrefixListIds).length > 0) problems.push("a CIDR or prefix-list source (public direct ingress)");
    const sources = arr(p.UserIdGroupPairs).map((u) => obj(u).GroupId);
    if (sources.length !== 1 || sources[0] !== alb.GroupId) problems.push(`sources [${sources.join(", ")}], not the ALB's ${String(alb.GroupId)}`);
  }
  const albProblems: string[] = [];
  const albPermissions = arr(alb.IpPermissions).map(obj);
  if (albPermissions.length === 0) albProblems.push("no ingress");
  for (const p of albPermissions) {
    if (p.IpProtocol !== "tcp" || p.FromPort !== 443 || p.ToPort !== 443) albProblems.push(`ingress ${String(p.IpProtocol)} ${String(p.FromPort)}-${String(p.ToPort)}`);
    if (arr(p.IpRanges).length > 0 || arr(p.Ipv6Ranges).length > 0 || arr(p.UserIdGroupPairs).length > 0 || arr(p.PrefixListIds).length === 0) albProblems.push("a source other than a prefix list (CloudFront's origin-facing list)");
  }
  return [
    judge("task security group: ALB only", problems.length === 0, `tcp ${expect.port} from ${String(alb.GroupId)} only`, problems.join("; ")),
    judge("ALB security group: CloudFront only", albProblems.length === 0, "tcp 443 from a prefix list only", albProblems.join("; ")),
  ];
}

/** The HTTPS listener's rules (`aws elbv2 describe-rules` output): /gs* forwards to the primary's target group. */
export function checkListenerRulesEvidence(doc: Json, targetGroupArn: string | null): Check[] {
  const rules = arr(obj(doc).Rules).map(obj);
  const gs = rules.filter((r) => arr(r.Conditions).some((c) => obj(c).Field === "path-pattern" && arr(obj(obj(c).PathPatternConfig).Values ?? obj(c).Values).map(String).includes("/gs*")));
  if (gs.length !== 1) return [fail("ALB /gs* rule", `${gs.length} listener rules match /gs*`)];
  const actions = arr(gs[0].Actions).map(obj);
  const forward = actions.find((a) => a.Type === "forward");
  const target = str(forward?.TargetGroupArn) ?? str(arr(obj(obj(forward?.ForwardConfig).TargetGroups)).map(obj)[0]?.TargetGroupArn);
  return [judge("ALB /gs* rule", target !== null && target === targetGroupArn, `/gs* -> ${target}`, `/gs* forwards to ${target}, not the primary service's target group ${targetGroupArn}`)];
}

/* ------------------------------------------------------------------ */
/* Evidence files                                                       */
/* ------------------------------------------------------------------ */

export const EVIDENCE_FILES = Object.freeze({
  taskDefinition: (pool: string) => `task-definition-${pool}.json`,
  services: "services.json",
  targetGroups: "target-groups.json",
  loadBalancerAttributes: "load-balancer-attributes.json",
  distributionConfig: "distribution-config.json",
  originRequestPolicy: "origin-request-policy.json",
  securityGroups: "security-groups.json",
  listenerRules: "listener-rules.json",
  /** LIVE-6 L6-5B: `aws cloudwatch describe-alarms --alarm-name-prefix gs-<env>-` (metric and composite alarms). */
  alarms: "alarms.json",
});

/** Every control-plane check over an evidence directory (a missing or unparseable file is a failure, never a skip). */
export function checkEvidenceDirectory(
  dir: string,
  expect: {
    readonly environment: string;
    readonly pools: readonly string[];
    readonly primaryPool: string;
    readonly port: number;
    readonly runtimeParameterArns: ReadonlyMap<string, string>;
    /** LIVE-6 L6-2: the trusted route table (pool -> ws_path) every runtime document v2 carries. */
    readonly routes: Readonly<Record<string, string>>;
    /** LIVE-6 L6-2: when a flip was made (the flip record's CAS time): the role-change checks run from it. */
    /** After a flip (`--flip-record`): its instant, its two pools, and whether it was a rollback (the failing pool's own
     *  role change is then reported, not required). Only the flip's two pools are judged. */
    readonly flip?: { readonly since: number; readonly from: string; readonly to: string; readonly rollback: boolean } | null;
    readonly now?: number;
    /** LIVE-6 L6-5B: the alarms against the contract. Absent: the alarm evidence is not judged (reported "skipped" by the
     *  caller, never silently). */
    readonly alarms?: {
      readonly escrow: boolean;
      readonly pageActions: readonly string[] | null;
      readonly ticketActions: readonly string[] | null;
      /** The flip's window (its record), when one may still be open. */
      readonly window: FlipWindowFacts | null;
    };
  },
): Check[] {
  const read = (file: string): { ok: true; value: Json } | { ok: false; check: Check } => {
    const where = path.join(dir, file);
    try {
      /* Windows PowerShell 5.1 writes UTF-8 with a byte-order mark; JSON.parse does not accept one. */
      return { ok: true, value: JSON.parse(fs.readFileSync(where, "utf8").replace(/^\uFEFF/, "")) as Json };
    } catch (error) {
      return { ok: false, check: fail(`evidence ${file}`, `missing or not JSON (${describeError(error)})`) };
    }
  };
  const checks: Check[] = [];
  const services = read(EVIDENCE_FILES.services);
  checks.push(...(services.ok ? checkServicesEvidence(services.value, expect) : [services.check]));
  const serviceOf = (pool: string) => (services.ok ? arr(obj(services.value).services).map(obj).find((x) => x.serviceName === expectedNames(expect.environment, 1).service(pool)) : undefined);
  for (const pool of expect.pools) {
    const doc = read(EVIDENCE_FILES.taskDefinition(pool));
    const arn = expect.runtimeParameterArns.get(pool);
    if (!doc.ok) checks.push(doc.check);
    else if (arn === undefined) checks.push(fail(`task definition ${pool}`, "no runtime parameter ARN for this pool"));
    else {
      /* The evidence must be the revision the service RUNS (after a rollback the family's latest revision is not). */
      const described = str(obj(obj(doc.value).taskDefinition).taskDefinitionArn);
      const running = str(serviceOf(pool)?.taskDefinition);
      checks.push(judge(`task definition ${pool}: the running revision`, described !== null && described === running, String(described), `the evidence is ${described}, the service runs ${running}`));
      checks.push(...checkTaskDefinitionEvidence(pool, doc.value, { environment: expect.environment, runtimeParameterArn: arn, port: expect.port }));
    }
  }
  const manifest = read(POOL_EVIDENCE_FILES.manifest);
  checks.push(...(manifest.ok ? checkManifest(manifest.value, { environment: expect.environment, pools: expect.pools, now: expect.now ?? Date.now(), maxAgeMs: null }) : [manifest.check]));
  /* LIVE-6 L6-2: one target group per pool, each pool's health, its own group, the rules and the rollback targets. */
  const groups = read(EVIDENCE_FILES.targetGroups);
  let targetGroups: ReadonlyMap<string, string> = new Map();
  if (groups.ok) {
    const judged = checkPoolTargetGroups(groups.value, { environment: expect.environment, pools: expect.pools });
    checks.push(...judged.checks);
    targetGroups = judged.arns;
  } else checks.push(groups.check);
  if (services.ok) checks.push(...checkPoolServices(services.value, { environment: expect.environment, pools: expect.pools, targetGroups }));
  for (const pool of expect.pools) {
    const health = read(POOL_EVIDENCE_FILES.targetHealth(pool));
    const desired = services.ok ? poolServiceOf(services.value, expect.environment, pool)?.desired : null;
    if (!health.ok) checks.push(health.check);
    else checks.push(checkTargetHealth(pool, health.value, desired === 0 ? 0 : 1));
    const revisions = readRevisions(dir, pool);
    checks.push(revisions.ok ? checkIdentityLayout(pool, revisions.docs) : revisions.check);
    const flip = expect.flip ?? null;
    if (flip !== null && (pool === flip.from || pool === flip.to)) {
      const stopped = read(POOL_EVIDENCE_FILES.stoppedTasks(pool));
      const running = read(POOL_EVIDENCE_FILES.runningTasks(pool));
      if (!stopped.ok) checks.push(stopped.check);
      if (!running.ok) checks.push(running.check);
      if (stopped.ok && running.ok) {
        const judged = checkRoleChange(pool, expect.environment, stopped.value, running.value, flip.since);
        checks.push(...(flip.rollback && pool === flip.from ? judged.map((c) => (c.status === "fail" ? { ...c, status: "skipped" as const, detail: `(rollback: ${pool} is the pool that failed to promote) ${c.detail}` } : c)) : judged));
      }
    }
  }
  const lb = read(EVIDENCE_FILES.loadBalancerAttributes);
  checks.push(...(lb.ok ? checkLoadBalancerEvidence(lb.value) : [lb.check]));
  const dist = read(EVIDENCE_FILES.distributionConfig);
  const orp = read(EVIDENCE_FILES.originRequestPolicy);
  if (!dist.ok) checks.push(dist.check);
  if (!orp.ok) checks.push(orp.check);
  if (dist.ok && orp.ok) checks.push(...checkEdgeEvidence(dist.value, orp.value));
  const sgs = read(EVIDENCE_FILES.securityGroups);
  checks.push(...(sgs.ok ? checkSecurityGroupsEvidence(sgs.value, expect) : [sgs.check]));
  const rules = read(EVIDENCE_FILES.listenerRules);
  checks.push(...(rules.ok ? checkPoolListenerRules(rules.value, { primary: expect.primaryPool, routes: expect.routes, targetGroups }) : [rules.check]));
  /* LIVE-6 L6-5B: the alarms (the services run: the heartbeat exists). */
  if (expect.alarms !== undefined) {
    const alarms = read(EVIDENCE_FILES.alarms);
    checks.push(
      ...(alarms.ok
        ? checkAlarmsEvidence(alarms.value, { environment: expect.environment, pools: expect.pools, primaryPool: expect.primaryPool, escrow: expect.alarms.escrow, services: true, pageActions: expect.alarms.pageActions, ticketActions: expect.alarms.ticketActions, flip: expect.alarms.window, now: expect.now ?? Date.now() })
        : [alarms.check]),
    );
  }
  return checks;
}
