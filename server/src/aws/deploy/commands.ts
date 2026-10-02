// server/src/aws/deploy/commands.ts
//
// ==================================================================
//  LIVE-5 L5-8: `npm run awsDeploy -- <command>` -- THE DEPLOY BOOTSTRAP AND THE READ-ONLY VERIFIER
// ==================================================================
//
//   bootstrap   --runtime-parameter <SSM ARN> --environment <env> --primary-pool <pool> --generation <N> --by <who>
//               [--apply | --check]
//       The runtime document named (the PRIMARY pool's) is read and checked by the task's own code (`loadAwsStartup`),
//       and its environment, pool and generation must equal the flags: the command is explicit about what it is for, and
//       refuses a mis-pointed document. Then APPGEN, SYSTEM/GENERATION (L6-4's marker) and SYSTEM/ROUTING (`bootstrap.ts`):
//         (default)  DRY RUN: both records' state and what --apply would create; exit 1 if either is incompatible
//         --apply    create what is absent (APPGEN, then the routing); exit 0 bootstrapped, 1 refused (nothing
//                    written), 3 unknown outcome (run it again: it can never write twice)
//         --check    exit 0 only if all three already hold the desired state
//
//   verify      --runtime-parameter <SSM ARN> --environment <env> --primary-pool <pool> --generation <N>
//               [--pools p1,p2] (--evidence <dir> | --no-evidence) [--flip-record <file>] [--part app|all]
//               [--game-generations 1,2] [--page-actions <arn,...>] [--ticket-actions <arn,...>]
//       LIVE-6 L6-5B: every managed game-table generation (default: the serving one) is checked for TTL `ttl`; with
//       evidence, the CloudWatch alarms against alarm-contract.json (`controlPlane/alarmContract.ts`). The action lists,
//       when given (an EMPTY value is a valid staging answer), must be exactly the page / ticket alarms' destinations.
//   verify      --topology (coexist | single-host) ... --evidence <host capture dir> --instance-id <i-...|none> ...
//       COST-2A (`hostVerify.ts`): the same data plane; the control plane judged from the SINGLE HOST's evidence
//       (infra/aws/scripts/capture-host-evidence, the operator's `gamesDoctor aws host-snapshot`) -- coexistence (the ECS
//       era drained) or the final state (the ECS era absent). Three answers: exit 0 VERIFIED, 1 FAIL, 3 NOT EVALUATED (a
//       read that failed is never a pass). `--topology ecs` (the default) is everything above, unchanged.
//   verify      --part ledger --ledger-table-arn <ARN> --environment <env> --generation <N>
//       Read-only (`deployVerify.ts`). `app` (the default) runs with the app account's credentials (the bootstrap role):
//       the documents, the game and identity tables in full, the ledger's DescribeTable (cross-account), APPGEN, the
//       routing, the KMS keys, and the control-plane evidence. The ledger's PITR and TTL cannot be read across accounts:
//       `--part ledger` with the LEDGER account's credentials checks them (and APPGEN); `--part all` does both halves with
//       credentials that reach both (the single-account form). Exit 0 only if every check passed.
//
//   signer-keys --relayer <key ARN> --settlement <key ARN> --admission <key ARN>
//       Read-only: each key's metadata and its compressed public key (and the relayer's juno address), derived exactly as
//       the server derives them -- the values the app stack's `escrow` variable needs. Public material only.
//
//   generation-gate --runtime-parameter <serving SSM ARN> --environment <env> --generation <N+1> --restore-id <id>
//       LIVE-6 L6-2 (L6-4 §12.2): read-only -- exit 0 only when APPGEN's adoption of exactly (N+1, g<N+1>, restore) has
//       settled; only then may the runtime documents move to the new generation (infra/aws/README.md "Generation switch").
//
//   relayer-rotation-gate --runtime-parameter <SSM ARN> --environment <env> --from-relayer <old> --to-relayer <new>
//                         --evidence <dir> [--record <file>]
//       LIVE-6 L6-2 for L6-7 (`relayerRotation.ts`), read-only. LIVE-6 relayer rotation: also reads the escrow contract's
//       operator from the chain (it must be the old or the new relayer) and records, in the v2 gate record, the
//       deployment the rotation must leave untouched (`gateRecords.ts`).
//
//   set-operator-plan --runtime-parameter <SSM ARN> --environment <env> --to-relayer <new> [--to-relayer-key <key ARN>]
//       LIVE-6 relayer rotation (`junoChain.ts`), READ-ONLY: the contract's admin (the ONE account that may send it) and
//       its current operator, read from the chain; the exact `set_operator` message for the admin to sign OUTSIDE this
//       tool (nothing here holds, asks for or uses the admin's key); and whether the `--to-relayer` account exists on chain
//       with at least the one-game operational planning reserve (`relayerFunding`, LIVE-6 L6-12D: 73 transactions x the
//       gas policy's effective per-transaction cap -- 8.2125 JUNOX by default; the derivation is printed). With
//       `--to-relayer-key`, the address must be the one that KMS key controls (derived as the server derives it). The
//       reserve is ALWAYS evaluated, also when the contract's operator is already `--to-relayer` (S2: the command doubles as
//       the ACTIVE relayer's readiness check). Exit 0: ready, or already set AND funded; 1: not ready (said why), including
//       already set but under the reserve. A rollback (`--to-relayer <old>`): the old relayer signs no transaction during
//       the rollback itself; it must hold the reserve BEFORE the rollback's pools restart and can receive new money work
//       (a just-in-time top-up), never as a pre-funding condition of the forward rotation.
//
//   migration-guard <gate> --plan-evidence <dir> --environment <env> --app-account <id> [...]
//   migration-guard nat --evidence <dir>
//       COST-2B (`migration/migrationCommands.ts`), OFFLINE: each dangerous Terraform step of
//       infra/aws/SINGLE_HOST_MIGRATION.md judged from its saved plan (fail closed), and the NAT deletion's evidence.
//
// Credentials: the SDK's default chain (the operator's profile or the pipeline's role -- the task's refusal of static
// keys is the RUNTIME's rule, not this tool's). Regions: the runtime document's and the ARNs', never the environment's.
// Nothing here prints a credential or a document's content; nothing but `bootstrap --apply` writes (and a migration
// guard's own create-once `--record`).

import * as path from "path";

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { KMSClient } from "@aws-sdk/client-kms";

import { addressOfPublicKey } from "../../escrow/juno/cosmosTx";
import { compressedKeyFromSpki, type KmsClient } from "../../escrow/juno/signer";
import { parseDynamoTableArn, parseKmsKeyArn, parseSsmParameterArn } from "../arns";
import { loadAwsStartup, type AwsStartup } from "../runtime/awsMain";
import type { ParameterSource } from "../runtime/configSource";
import { AWS_RUNTIME_CONFIG_FORMAT_V2 } from "../runtime/runtimeConfig";
import { flipWindowOfFile, readFlipRecordFile } from "../controlPlane/flipRecord";
import { checkDrained, checkManifest, POOL_EVIDENCE_FILES, readEvidence, type Check as GateCheck } from "../controlPlane/evidence";
import { RELAYER_ADDRESS, relayQueueState } from "./relayerRotation";
import { migrationGuardCommand } from "./migration/migrationCommands";
import { GENERATION_GATE_FORMAT, ROTATION_GATE_FORMAT, writeGateRecord } from "./gateRecords";
import type { FlipWindowFacts } from "../controlPlane/alarmContract";
import { adoptionBindingProblem, generationMarkerProblem, readGenerationMarker, type GenerationMarker } from "../game/generationMarker";
import { readAdoptionRecord, readAppGeneration } from "../ledger/appGeneration";
import { applyBootstrap, bootstrapPlan, BootstrapUnknownError, inspectBootstrap, type BootstrapClients, type BootstrapTarget, type RecordState } from "./bootstrap";
import {
  checkControlRecords,
  checkEvidenceDirectory,
  checkRuntimeDocument,
  checkSigningKeys,
  checkTable,
  expectedNames,
  kmsKeyReader,
  readTableEvidence,
  skipped,
  type Check,
} from "./deployVerify";
import { VERIFY_RECORD_FORMAT, writeRecord } from "./staging/evidence";
import { checkHostEvidenceDirectory, HOST_INSTANCE_TYPES, HOST_REPORT_FORMAT, HOST_TOPOLOGIES, hostFacts, verdictOf, writeHostReport, type HostExpect, type HostTopology } from "./hostVerify";
import { contractControl, deploymentIdentityOf, displayUnits, relayerFunding, relayerFundingDerivation, setOperatorMessage, type ContractControl, type JunoChainReader } from "./junoChain";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNKNOWN = 3;

/** What the commands reach the world through (production: `tools/awsDeploy.ts`; tests: DynamoDB Local and fakes). */
export interface DeployDeps {
  readonly parameters: ParameterSource;
  readonly dynamo: (region: string) => DynamoDBClient;
  readonly kms: (region: string) => { readonly sdk: KMSClient; readonly digest: KmsClient };
  readonly now: () => number;
  readonly out: (line: string) => void;
  /** Tests only: the table names the clients address (production: the document's names and the ledger ARN). */
  readonly tables?: (config: { readonly gameTable: string; readonly identityTable: string; readonly ledgerArn: string }) => { readonly game: string; readonly identity: string; readonly ledger: string };
  /** LIVE-6 relayer rotation: the escrow contract on chain, read only (`junoChain.ts`; production `productionJunoChain`).
   *  Absent: every chain-dependent check FAILS "not bound" (never skipped, never assumed). */
  readonly juno?: JunoChainReader;
}

export class UsageError extends Error {}

export function parseFlags(argv: readonly string[], allowed: readonly string[], booleans: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (!name.startsWith("--")) throw new UsageError(`unexpected argument ${JSON.stringify(name)}`);
    if (booleans.includes(name)) {
      if (flags.has(name)) throw new UsageError(`${name} given twice`);
      flags.set(name, "true");
      continue;
    }
    if (!allowed.includes(name)) throw new UsageError(`unknown flag ${name}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${name} needs a value`);
    if (flags.has(name)) throw new UsageError(`${name} given twice`);
    flags.set(name, value);
    i += 1;
  }
  return flags;
}

export const need = (flags: Map<string, string>, name: string): string => {
  const value = flags.get(name);
  if (value === undefined) throw new UsageError(`${name} is required`);
  return value;
};

export const generationOf = (text: string): number => {
  if (!/^[1-9][0-9]{0,15}$/.test(text) || !Number.isSafeInteger(Number(text))) throw new UsageError("--generation must be a positive whole number");
  return Number(text);
};

const ENVIRONMENT = /^[a-z][a-z0-9-]{0,31}$/;
export const environmentOf = (text: string): string => {
  if (!ENVIRONMENT.test(text)) throw new UsageError("--environment must match ^[a-z][a-z0-9-]{0,31}$");
  return text;
};

/** COST-2A: the verifier's third exit -- nothing failed, but something required could not be evaluated (never VERIFIED). */
export const EXIT_NOT_EVALUATED = 3;

export function report(out: (line: string) => void, checks: readonly Check[]): number {
  const word = (c: Check) => (c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : c.status === "not-evaluated" ? "NOT EVALUATED" : "SKIP");
  for (const check of checks) out(`${word(check)}  ${check.name} -- ${check.detail}`);
  const failed = checks.filter((c) => c.status === "fail").length;
  const skippedCount = checks.filter((c) => c.status === "skipped").length;
  const unevaluated = checks.filter((c) => c.status === "not-evaluated").length;
  const passed = checks.length - failed - skippedCount - unevaluated;
  if (unevaluated === 0) {
    /* Byte-identical to L5-8's line when nothing was left unevaluated (every ECS-topology run). */
    out(`${failed === 0 ? "VERIFIED" : "NOT VERIFIED"}: ${passed} passed, ${failed} failed, ${skippedCount} skipped (named above)`);
    return failed === 0 ? EXIT_OK : EXIT_FAILED;
  }
  out(`${failed === 0 ? "NOT EVALUATED" : "NOT VERIFIED"}: ${passed} passed, ${failed} failed, ${unevaluated} not evaluated, ${skippedCount} skipped (named above)${failed === 0 ? " -- evidence is missing: this is NOT a pass" : ""}`);
  return failed === 0 ? EXIT_NOT_EVALUATED : EXIT_FAILED;
}

/** The runtime document the task would read, by the task's own code; its identity must be what the caller named. */
export async function loadAndMatch(deps: DeployDeps, arn: string, expect: { readonly environment: string; readonly pool: string; readonly generation: number }): Promise<AwsStartup> {
  const startup = await loadAwsStartup({ argv: [], env: { GS_AWS_CONFIG_PARAMETER: arn }, serverMode: "production", parameters: deps.parameters });
  const problems = checkRuntimeDocument(startup.config, expect).filter((c) => c.status === "fail");
  if (problems.length > 0) throw new UsageError(`the runtime document ${arn} (v${startup.configVersion}) is not the one asked for: ${problems.map((c) => c.detail).join("; ")}`);
  return startup;
}

export function clientsFor(deps: DeployDeps, startup: AwsStartup): { readonly clients: BootstrapClients; readonly tables: { readonly game: string; readonly identity: string; readonly ledger: string } } {
  const { config } = startup;
  const app = deps.dynamo(config.region);
  const ledger = config.ledger.region === config.region ? app : deps.dynamo(config.ledger.region);
  const tables = deps.tables?.({ gameTable: config.gameTable, identityTable: config.identityTable, ledgerArn: config.ledger.arn }) ?? { game: config.gameTable, identity: config.identityTable, ledger: config.ledger.arn };
  return { clients: { app, ledger }, tables };
}

const stateLine = (name: string, state: RecordState) => `  ${name}: ${state.kind}${state.kind === "absent" ? "" : ` -- ${state.detail}`}`;

/* ------------------------------------------------------------------ */
/* bootstrap                                                            */
/* ------------------------------------------------------------------ */

export async function bootstrapCommand(argv: readonly string[], deps: DeployDeps): Promise<number> {
  const flags = parseFlags(argv, ["--runtime-parameter", "--environment", "--primary-pool", "--generation", "--by"], ["--apply", "--check"]);
  if (flags.has("--apply") && flags.has("--check")) throw new UsageError("--apply and --check are exclusive");
  const arn = need(flags, "--runtime-parameter");
  const environment = environmentOf(need(flags, "--environment"));
  const pool = need(flags, "--primary-pool");
  const generation = generationOf(need(flags, "--generation"));
  const by = need(flags, "--by");
  const startup = await loadAndMatch(deps, arn, { environment, pool, generation });
  const { clients, tables } = clientsFor(deps, startup);
  const target: BootstrapTarget = { gameTable: tables.game, gameTableName: startup.config.gameTable, ledgerTable: tables.ledger, primaryPool: pool, generation, by };
  deps.out(`bootstrap ${environment}: runtime document ${arn} v${startup.configVersion}; game ${startup.config.gameTable}; ledger ${startup.config.ledger.arn}; primary pool ${pool}; generation ${generation}`);

  if (!flags.has("--apply")) {
    const inspection = await inspectBootstrap(clients, target);
    deps.out(stateLine("APPGEN", inspection.appgen));
    deps.out(stateLine("SYSTEM/GENERATION", inspection.generation));
    deps.out(stateLine("SYSTEM/ROUTING", inspection.routing));
    const plan = bootstrapPlan(inspection);
    if (flags.has("--check")) {
      const done = inspection.appgen.kind === "matches" && inspection.generation.kind === "matches" && inspection.routing.kind === "matches";
      deps.out(done ? "BOOTSTRAPPED: both records hold the desired state" : "NOT BOOTSTRAPPED");
      return done ? EXIT_OK : EXIT_FAILED;
    }
    if (plan.refused.length > 0) {
      for (const reason of plan.refused) deps.out(`  REFUSED: ${reason}`);
      deps.out("DRY RUN: --apply would write NOTHING (an existing record is incompatible or unreadable; the bootstrap never overwrites)");
      return EXIT_FAILED;
    }
    deps.out(plan.writes.length === 0 ? "DRY RUN: nothing to write (already bootstrapped)" : `DRY RUN: --apply would create ${plan.writes.join(" and ")}`);
    return EXIT_OK;
  }

  try {
    const outcome = await applyBootstrap(clients, target, { now: deps.now });
    deps.out(stateLine("APPGEN", outcome.inspection.appgen));
    deps.out(stateLine("SYSTEM/GENERATION", outcome.inspection.generation));
    deps.out(stateLine("SYSTEM/ROUTING", outcome.inspection.routing));
    if (outcome.kind === "refused") {
      for (const reason of outcome.reasons) deps.out(`  REFUSED: ${reason}`);
      deps.out("NOT BOOTSTRAPPED: nothing incompatible was overwritten");
      return EXIT_FAILED;
    }
    deps.out(`BOOTSTRAPPED: APPGEN ${outcome.appgen}, SYSTEM/GENERATION ${outcome.generation}, SYSTEM/ROUTING ${outcome.routing}`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof BootstrapUnknownError) {
      deps.out(`UNKNOWN: ${error.message}`);
      return EXIT_UNKNOWN;
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* verify                                                               */
/* ------------------------------------------------------------------ */

const siblingRuntimeParameter = (primaryArn: string, environment: string, pool: string): string => {
  const parsed = parseSsmParameterArn(primaryArn);
  if ("problem" in parsed) throw new UsageError(`--runtime-parameter: ${parsed.problem}`);
  return `arn:aws:ssm:${parsed.region}:${parsed.account}:parameter/gs/${environment}/runtime/${pool}`;
};

/** L6-5B: `--game-generations 1,2` (every managed generation; default the serving one). */
export function gameGenerationsOf(flags: Map<string, string>, serving: number): number[] {
  const text = flags.get("--game-generations");
  if (text === undefined) return [serving];
  const list = text.split(",").map((g) => g.trim()).filter((g) => g.length > 0).map((g) => generationOf(g));
  if (!list.includes(serving)) throw new UsageError("--game-generations must include the serving --generation");
  return [...new Set(list)].sort((a, b) => a - b);
}

/** L6-5B: an alarm action list flag -- absent: not judged (class consistency only); `none` (or empty): none configured. */
export function actionListOf(flags: Map<string, string>, name: string): string[] | null {
  const text = flags.get(name);
  if (text === undefined) return null;
  if (text === "none") return []; // an empty list, spelled so PowerShell cannot drop it
  const list = text.split(",").map((a) => a.trim()).filter((a) => a.length > 0);
  for (const arn of list) if (!/^arn:aws:(sns|lambda|ssm-incidents|ssm):[a-z0-9-]*:[0-9]{12}:.+$/.test(arn)) throw new UsageError(`${name}: ${arn.slice(0, 100)} is not a CloudWatch alarm action ARN`);
  return list;
}

/** What `verify --part app|all` checks (the options `verify`'s flags name; LIVE-6 L6-6's certification passes them too). */
export interface VerifyOptions {
  readonly part: "app" | "all";
  readonly runtimeParameterArn: string;
  readonly environment: string;
  readonly primaryPool: string;
  readonly generation: number;
  readonly pools: readonly string[];
  readonly port: number;
  /** The control-plane evidence directory, or null for `--no-evidence` (reported SKIP). */
  readonly evidenceDir: string | null;
  /** LIVE-6 L6-2 / L6-5B (`--flip-record`): the flip record whose window the evidence (routing, suppressors) is judged in. */
  readonly flipRecordFile?: string | null;
  /** LIVE-6 L6-5B (`--game-generations`): every managed game-table generation checked for TTL `ttl` (default: the serving one). */
  readonly gameGenerations?: readonly number[];
  /** LIVE-6 L6-5B (`--page-actions` / `--ticket-actions`): the alarm classes' exact destinations; null = not judged. */
  readonly pageActions?: readonly string[] | null;
  readonly ticketActions?: readonly string[] | null;
  /** COST-2A (`--topology`): `ecs` (absent: L5-8 / L6-2's control plane, unchanged), or a host topology whose control
   *  plane is judged from a host capture (`hostVerify.ts`). The data plane above is the same for every topology. */
  readonly topology?: "ecs" | HostTopology;
  readonly host?: HostVerifyOptions;
}

/** COST-2A: what the host topologies' control plane is compared against, beyond the runtime documents. */
export interface HostVerifyOptions {
  /** null: coexistence before the host exists (`--instance-id none`). */
  readonly instanceId: string | null;
  readonly originHostname: string | null;
  readonly gsOrigin: string;
  readonly siteOrigin: string | null;
  readonly instanceType: string | null;
  readonly emergencySsh: boolean;
  readonly junoEgressPorts: readonly number[];
  readonly budget: "required" | "not-required";
  readonly expectDigest: string | null;
  readonly expectBuild: string | null;
  readonly allowNatGateways: readonly string[];
  readonly allowVpcEndpoints: readonly string[];
  readonly allowEips: readonly string[];
  readonly legacyVpcs: readonly string[];
  readonly legacyPools: readonly string[];
  readonly alarmActions: readonly string[] | null;
  readonly maxAgeMs: number;
}

/** COST-2A: the host topologies' expectations, from the runtime documents (parsed by the task's own code) and the flags. */
export async function hostExpectations(options: VerifyOptions, startup: AwsStartup, clients: { readonly app: DynamoDBClient; readonly game: string }, now: number): Promise<HostExpect> {
  const host = options.host;
  if (host === undefined || options.topology === undefined || options.topology === "ecs") throw new UsageError("the host topologies need their host options");
  const parameter = parseSsmParameterArn(options.runtimeParameterArn);
  if ("problem" in parameter) throw new UsageError(`--runtime-parameter: ${parameter.problem}`);
  const { config } = startup;
  const table = (name: string) => `arn:aws:dynamodb:${config.region}:${parameter.account}:table/${name}`;
  const escrow = startup.escrowConfig;
  const keys = escrow === null ? null : [escrow.relayer.signer, escrow.settlementKey.signer, escrow.admissionKey.signer].map((s) => (s.kind === "kms" ? s.key_ref : `${s.kind}:(not a KMS key)`));
  let relayer: HostExpect["relayer"] = null;
  if (escrow !== null) {
    const queue = await relayQueueState(clients.app, clients.game, escrow.relayer.address);
    relayer = { address: escrow.relayer.address, queue: queue.state === "empty" ? { state: "empty" } : queue.state === "open" ? { state: "open", entries: queue.entries } : { state: "unknown", detail: queue.detail } };
  }
  return {
    topology: options.topology,
    environment: options.environment,
    region: config.region,
    account: parameter.account,
    pool: options.primaryPool,
    generation: options.generation,
    instanceId: host.instanceId,
    originHostname: host.originHostname,
    gsOrigin: host.gsOrigin,
    siteOrigin: host.siteOrigin,
    instanceType: host.instanceType,
    emergencySsh: host.emergencySsh,
    junoEgressPorts: host.junoEgressPorts,
    budget: host.budget,
    expectDigest: host.expectDigest,
    expectBuild: host.expectBuild,
    allowNatGateways: host.allowNatGateways,
    allowVpcEndpoints: host.allowVpcEndpoints,
    allowEips: host.allowEips,
    legacyVpcs: host.legacyVpcs,
    /* The ECS era's pools, by exact resource name: the route table's (p2 until step I), the convention's p1 / p2, and any
       the operator names (`--legacy-pools`). */
    legacyPools: [...new Set([...Object.keys(config.routes), config.pool, "p1", "p2", ...host.legacyPools])].sort(),
    alarmActions: host.alarmActions,
    authorities: {
      gameTableArns: (options.gameGenerations ?? [options.generation]).map((g) => table(expectedNames(options.environment, g).gameTable)).sort(),
      identityTableArn: table(config.identityTable),
      ledgerTableArn: config.ledger.arn,
      runtimeParameterArn: options.runtimeParameterArn,
      junoParameterArn: config.escrow === null ? null : config.escrow.configParameter.arn,
      kmsKeyArns: keys,
    },
    relayer,
    now,
    maxAgeMs: host.maxAgeMs,
  };
}

/** The verifier's checks for the app half (and, with `part: "all"`, the ledger's PITR and TTL too). Read-only. Returns the
 *  parsed documents as well (the certification needs the escrow configuration and the pools' runtime document ARNs). */
export async function collectVerification(options: VerifyOptions, deps: DeployDeps): Promise<{ readonly checks: Check[]; readonly startup: AwsStartup; readonly runtimeArns: ReadonlyMap<string, string>; readonly host?: HostExpect }> {
  const { part, environment, generation, primaryPool: primary, pools, port } = options;
  const arn = options.runtimeParameterArn;
  const names = expectedNames(environment, generation);
  const checks: Check[] = [];
  if (!pools.includes(primary)) throw new UsageError("--pools must include the primary pool");
  const topology = options.topology ?? "ecs";
  /* COST-2A: a host topology is never verified without its evidence (a data-plane-only run is not a host verification). */
  if (topology !== "ecs" && (options.evidenceDir === null || options.host === undefined)) throw new UsageError(`--topology ${topology} needs its host evidence (--evidence <dir> from infra/aws/scripts/capture-host-evidence) and its host options`);
  if (topology !== "ecs" && (options.flipRecordFile ?? null) !== null) throw new UsageError("--flip-record is the ECS topology's (a pool flip); the single host has one pool");
  /* The final state has ONE pool: its route table, its documents -- `--pools` cannot widen it (a p2 route or document left
     behind then fails "route table = the deployed pools"). */
  if (topology === "single-host" && (pools.length !== 1 || pools[0] !== primary)) throw new UsageError(`--topology single-host has one pool: --pools must be exactly the primary (${primary}); a route table still naming another pool fails the verification`);

  /* The documents, by the task's own code, for every pool. */
  const startup = await loadAndMatch(deps, arn, { environment, pool: primary, generation });
  checks.push({ name: `runtime document ${primary}`, status: "pass", detail: `v${startup.configVersion} parsed by the task's own code (loadAwsStartup)${startup.escrowConfig === null ? "; escrow null" : `; Juno configuration v${startup.escrowConfigVersion} parsed and checked for AWS storage`}` });
  const runtimeArns = new Map<string, string>([[primary, arn]]);
  const siblingConfigs = new Map<string, AwsStartup["config"]>();
  for (const pool of pools.filter((p) => p !== primary)) {
    const sibling = siblingRuntimeParameter(arn, environment, pool);
    runtimeArns.set(pool, sibling);
    try {
      const other = await loadAndMatch(deps, sibling, { environment, pool, generation });
      siblingConfigs.set(pool, other.config);
      checks.push({ name: `runtime document ${pool}`, status: "pass", detail: `v${other.configVersion}` });
      const same = other.config.gameTable === startup.config.gameTable && other.config.identityTable === startup.config.identityTable && other.config.ledger.arn === startup.config.ledger.arn && JSON.stringify(other.config.escrow) === JSON.stringify(startup.config.escrow);
      checks.push({ name: `runtime document ${pool}: same tables and escrow`, status: same ? "pass" : "fail", detail: same ? "as the primary's" : "names other tables or another escrow configuration than the primary's" });
    } catch (error) {
      checks.push({ name: `runtime document ${pool}`, status: "fail", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  /* LIVE-6 L6-2: the runtime document is v2 and its trusted route table is exactly the deployed pools (the same table in
     every pool's document is checked above: "same tables and escrow" compares the whole escrow; the routes below). */
  const routes: Record<string, string> = Object.fromEntries(Object.entries(startup.config.routes).map(([pool, entry]) => [pool, entry.wsPath]));
  checks.push({ name: "runtime document v2", status: startup.config.format === AWS_RUNTIME_CONFIG_FORMAT_V2 ? "pass" : "fail", detail: startup.config.format === AWS_RUNTIME_CONFIG_FORMAT_V2 ? AWS_RUNTIME_CONFIG_FORMAT_V2 : `${startup.config.format}: LIVE-6 production configuration is v2 (the trusted route table)` });
  const routePools = Object.keys(routes).sort();
  checks.push({ name: "route table = the deployed pools", status: routePools.join(",") === [...pools].sort().join(",") ? "pass" : "fail", detail: `routes [${routePools.join(", ")}], pools [${[...pools].sort().join(", ")}]` });
  for (const [pool, other] of siblingConfigs) {
    const same = JSON.stringify(Object.entries(other.routes).sort()) === JSON.stringify(Object.entries(startup.config.routes).sort());
    checks.push({ name: `runtime document ${pool}: same route table`, status: same ? "pass" : "fail", detail: same ? "as the primary's" : "another route table than the primary's (every pool must route alike)" });
  }
  let flip: { readonly since: number; readonly from: string; readonly to: string; readonly rollback: boolean } | null = null;
  let flipWindow: FlipWindowFacts | null = null;
  const flipRecordFile = options.flipRecordFile ?? null;
  if (flipRecordFile !== null) {
    const record = readFlipRecordFile(flipRecordFile);
    if ("problem" in record) checks.push({ name: "flip record", status: "fail", detail: record.problem });
    else {
      flip = { since: record.since, from: record.from, to: record.to, rollback: record.rollback };
      flipWindow = flipWindowOfFile(flipRecordFile);
      checks.push({ name: "flip record: primary", status: record.to === primary ? "pass" : "fail", detail: record.to === primary ? `the flip made ${record.to} primary (routing v${record.version})` : `the flip record names ${record.to}, --primary-pool is ${primary}` });
    }
  }

  const { clients, tables } = clientsFor(deps, startup);
  /* LIVE-6 L6-5B: TTL `ttl` (L6-5A's diagnostic TASK# items) on the serving table -- and on every other managed generation
     named, where an old generation's straggler writes its heartbeat. */
  checks.push(...checkTable("game table", await readTableEvidence(clients.app, tables.game, { backupsAndTtl: true }), { name: names.gameTable, ttlAttribute: "ttl" }));
  for (const other of (options.gameGenerations ?? [generation]).filter((g) => g !== generation)) {
    const otherName = expectedNames(environment, other).gameTable;
    const physical = deps.tables?.({ gameTable: otherName, identityTable: startup.config.identityTable, ledgerArn: startup.config.ledger.arn }).game ?? otherName;
    checks.push(...checkTable(`game table g${other}`, await readTableEvidence(clients.app, physical, { backupsAndTtl: true }), { name: otherName, ttlAttribute: "ttl" }));
  }
  checks.push(...checkTable("identity table", await readTableEvidence(clients.app, tables.identity, { backupsAndTtl: true }), { name: names.identityTable, ttlAttribute: "ttl" }));
  const ledgerChecks = checkTable("ledger table", await readTableEvidence(clients.ledger, tables.ledger, { backupsAndTtl: part === "all" }), { name: names.ledgerTable, ttlAttribute: null });
  checks.push(...(part === "all" ? ledgerChecks : ledgerChecks.filter((c) => !c.name.endsWith(": PITR") && !c.name.endsWith(": TTL"))));
  if (part === "app") checks.push(skipped("ledger table: PITR and TTL", "not readable across accounts: run --part ledger with the ledger account's credentials"));
  checks.push(...(await checkControlRecords(clients, { gameTable: tables.game, gameTableName: startup.config.gameTable, ledgerTable: tables.ledger, primaryPool: primary, generation }, { appgen: true, routing: true, generation: true })));

  if (startup.escrowConfig === null) checks.push(skipped("KMS signing keys", "escrow is null in the runtime document"));
  else {
    const region = startup.escrowConfig.kmsRegion;
    if (region === null) checks.push({ name: "KMS signing keys", status: "fail", detail: "the escrow configuration names no KMS region" });
    else {
      const kms = deps.kms(region);
      checks.push(...(await checkSigningKeys(startup.escrowConfig, kmsKeyReader(kms.sdk, kms.digest))));
    }
  }

  if (topology !== "ecs") {
    /* COST-2A: the host's control plane (and, in coexistence, the drained ECS era; in the final state, its absence). */
    const host = await hostExpectations(options, startup, { app: clients.app, game: tables.game }, deps.now());
    checks.push(...checkHostEvidenceDirectory(options.evidenceDir as string, host, { escrow: startup.escrowConfig !== null }));
    return { checks, startup, runtimeArns, host };
  }
  if (options.evidenceDir === null) checks.push(skipped("control-plane evidence", "--no-evidence: task definitions, services, target group, ALB, edge and security groups NOT checked"));
  else {
    checks.push(
      ...checkEvidenceDirectory(options.evidenceDir, {
        environment,
        pools,
        primaryPool: primary,
        port,
        runtimeParameterArns: runtimeArns,
        routes,
        flip,
        now: deps.now(),
        alarms: { escrow: startup.escrowConfig !== null, pageActions: options.pageActions ?? null, ticketActions: options.ticketActions ?? null, window: flipWindow },
      }),
    );
  }
  return { checks, startup, runtimeArns };
}

/** `verify --record <file>`: the checks as a record (the certification reads the ledger half from one). */
function writeVerifyRecord(file: string, run: string | null, part: string, environment: string, generation: number, checks: readonly Check[], now: number, topology: "ecs" | HostTopology = "ecs"): void {
  /* L5-8's rule for the ECS topology, unchanged: PASS only when every check passed. COST-2A: a host topology's record
     carries the run's own three-valued verdict (the exit code's and the report's: a named skip is not a failure, an
     unevaluated check is never a pass) and names its topology. */
  const verdict = topology === "ecs" ? (checks.every((c) => c.status === "pass") ? "PASS" : "FAIL") : verdictOf(checks);
  const record = { format: VERIFY_RECORD_FORMAT, run_id: run, part, environment, generation, at: new Date(now).toISOString(), verdict, ...(topology === "ecs" ? {} : { topology }), checks };
  const dir = path.dirname(path.resolve(file));
  writeRecord(dir, path.basename(file), record);
}

const HOST_FLAGS: readonly string[] = Object.freeze([
  "--topology",
  "--instance-id",
  "--origin-hostname",
  "--gs-origin",
  "--site-origin",
  "--instance-type",
  "--juno-egress-ports",
  "--budget",
  "--expect-digest",
  "--expect-build",
  "--allow-nat",
  "--allow-vpc-endpoint",
  "--alarm-actions",
  "--max-evidence-age-minutes",
  "--report",
  "--allow-eip",
  "--legacy-vpc",
  "--legacy-pools",
]);
const DNS_NAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** COST-2A: `--topology` and the host topologies' options (each validated here; an ECS run refuses every host flag). */
export function hostOptionsOf(flags: Map<string, string>): { readonly topology: "ecs" | HostTopology; readonly host?: HostVerifyOptions; readonly reportDir: string | null } {
  const topology = flags.get("--topology") ?? "ecs";
  if (topology !== "ecs" && !(HOST_TOPOLOGIES as readonly string[]).includes(topology)) throw new UsageError("--topology is ecs, coexist or single-host");
  const hostFlags = HOST_FLAGS.filter((f) => f !== "--topology" && flags.has(f));
  if (topology === "ecs") {
    if (hostFlags.length > 0 || flags.has("--emergency-ssh")) throw new UsageError(`${[...hostFlags, ...(flags.has("--emergency-ssh") ? ["--emergency-ssh"] : [])].join(", ")}: host options need --topology coexist or single-host`);
    return { topology: "ecs", reportDir: null };
  }
  for (const ecsOnly of ["--no-evidence", "--flip-record", "--page-actions", "--ticket-actions"]) if (flags.has(ecsOnly)) throw new UsageError(`${ecsOnly} is the ECS topology's; --topology ${topology} judges the host (and the drained or absent ECS era) from its own evidence`);
  const idText = need(flags, "--instance-id");
  const instanceId = idText === "none" ? null : idText;
  if (instanceId !== null && !/^i-[0-9a-f]{8,17}$/.test(instanceId)) throw new UsageError("--instance-id is the host's instance id (i-...), or none (coexistence before the host exists)");
  if (instanceId === null && topology === "single-host") throw new UsageError("--instance-id none is coexistence only: the final state has its host");
  const dns = (name: string, required: boolean): string | null => {
    const value = flags.get(name);
    if (value === undefined) {
      if (required) throw new UsageError(`${name} is required`);
      return null;
    }
    if (!DNS_NAME.test(value)) throw new UsageError(`${name} must be a lower-case DNS name`);
    return value;
  };
  const originHostname = dns("--origin-hostname", instanceId !== null);
  /* The /gs* origin of THIS migration state: the host's in the final state (and after step G); before step G, the ALB's
     origin name -- explicit, so a verifier can never infer which side of the switch it is on. */
  let gsOrigin = dns("--gs-origin", topology === "coexist");
  if (topology === "single-host") {
    if (gsOrigin !== null && gsOrigin !== originHostname) throw new UsageError("--gs-origin: in the final state the /gs* origin IS the host's --origin-hostname");
    gsOrigin = originHostname;
  }
  const list = (name: string, pattern: RegExp, what: string): string[] => {
    const text = flags.get(name);
    if (text === undefined) return [];
    const items = text.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
    for (const item of items) if (!pattern.test(item)) throw new UsageError(`${name}: ${item.slice(0, 80)} is not ${what}`);
    return items;
  };
  const budget = flags.get("--budget") ?? "required";
  if (budget !== "required" && budget !== "not-required") throw new UsageError("--budget is required or not-required");
  const digest = flags.get("--expect-digest") ?? null;
  if (digest !== null && !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new UsageError("--expect-digest is the release image's sha256:<64 hex>");
  const build = flags.get("--expect-build") ?? null;
  if (build !== null && !/^[A-Za-z0-9._-]{1,128}$/.test(build)) throw new UsageError("--expect-build is a build id ([A-Za-z0-9._-]{1,128})");
  const type = flags.get("--instance-type") ?? null;
  if (type !== null && !HOST_INSTANCE_TYPES.includes(type)) throw new UsageError(`--instance-type is one of ${HOST_INSTANCE_TYPES.join(", ")}`);
  const ports = list("--juno-egress-ports", /^[0-9]{1,5}$/, "a TCP port").map(Number);
  if (ports.some((p) => p < 1 || p > 65535)) throw new UsageError("--juno-egress-ports are TCP ports");
  const minutes = Number(flags.get("--max-evidence-age-minutes") ?? "30");
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 24 * 60) throw new UsageError("--max-evidence-age-minutes is 1..1440");
  const actionsText = flags.get("--alarm-actions");
  const alarmActions = actionsText === undefined ? null : actionsText === "none" ? [] : list("--alarm-actions", /^arn:aws:(sns|lambda|ssm-incidents|ssm):[a-z0-9-]*:[0-9]{12}:.+$/, "a CloudWatch alarm action ARN");
  return {
    topology: topology as HostTopology,
    reportDir: flags.get("--report") ?? null,
    host: {
      instanceId,
      originHostname,
      gsOrigin: gsOrigin as string,
      siteOrigin: dns("--site-origin", false),
      instanceType: type,
      emergencySsh: flags.has("--emergency-ssh"),
      junoEgressPorts: ports,
      budget,
      expectDigest: digest,
      expectBuild: build,
      allowNatGateways: list("--allow-nat", /^nat-[0-9a-f]{8,17}$/, "a NAT gateway id"),
      allowVpcEndpoints: list("--allow-vpc-endpoint", /^vpce-[0-9a-f]{8,17}$/, "a VPC endpoint id"),
      allowEips: list("--allow-eip", /^eipalloc-[0-9a-f]{8,17}$/, "an Elastic IP allocation id"),
      legacyVpcs: list("--legacy-vpc", /^vpc-[0-9a-f]{8,17}$/, "a VPC id"),
      legacyPools: list("--legacy-pools", /^[a-z][a-z0-9-]{0,15}$/, "a pool id"),
      alarmActions,
      maxAgeMs: minutes * 60_000,
    },
  };
}

export async function verifyCommand(argv: readonly string[], deps: DeployDeps): Promise<number> {
  const flags = parseFlags(argv, ["--runtime-parameter", "--environment", "--primary-pool", "--generation", "--pools", "--evidence", "--part", "--ledger-table-arn", "--port", "--flip-record", "--game-generations", "--page-actions", "--ticket-actions", "--record", "--run-id", ...HOST_FLAGS], ["--no-evidence", "--emergency-ssh"]);
  const part = flags.get("--part") ?? "app";
  if (!["app", "ledger", "all"].includes(part)) throw new UsageError("--part is app, ledger or all");
  const environment = environmentOf(need(flags, "--environment"));
  const generation = generationOf(need(flags, "--generation"));
  const names = expectedNames(environment, generation);
  const record = flags.get("--record");
  const run = flags.get("--run-id") ?? null;

  if (part === "ledger") {
    if (flags.has("--topology") && flags.get("--topology") !== "ecs") throw new UsageError("--part ledger is the ledger account's half: it is the same for every topology (omit --topology)");
    if (HOST_FLAGS.some((f) => flags.has(f)) || flags.has("--emergency-ssh")) throw new UsageError("--part ledger takes no host option");
    const checks: Check[] = [];
    const arn = parseDynamoTableArn(need(flags, "--ledger-table-arn"));
    if ("problem" in arn) throw new UsageError(`--ledger-table-arn: ${arn.problem}`);
    if (arn.table !== names.ledgerTable) throw new UsageError(`--ledger-table-arn names ${arn.table}, not ${names.ledgerTable}`);
    const client = deps.dynamo(arn.region);
    const ledger = deps.tables?.({ gameTable: names.gameTable, identityTable: names.identityTable, ledgerArn: arn.arn }).ledger ?? arn.arn;
    checks.push(...checkTable("ledger table", await readTableEvidence(client, ledger, { backupsAndTtl: true }), { name: names.ledgerTable, ttlAttribute: null }));
    checks.push(...(await checkControlRecords({ app: client, ledger: client }, { gameTable: "-", ledgerTable: ledger, primaryPool: "p1", generation }, { appgen: true, routing: false })));
    /* The record is the ledger half alone (the certification pairs it with the app half); the terminal report says so. */
    if (record !== undefined) writeVerifyRecord(record, run, "ledger", environment, generation, checks, deps.now());
    checks.push(skipped("app account", "--part ledger checks the ledger account only; run --part app with the app account's credentials"));
    return report(deps.out, checks);
  }

  const hostOptions = hostOptionsOf(flags);
  if (flags.has("--evidence") === flags.has("--no-evidence")) throw new UsageError("name the control-plane evidence directory (--evidence <dir>, from infra/aws/scripts/capture-evidence) or skip it explicitly (--no-evidence)");
  const primary = need(flags, "--primary-pool");
  const port = Number(flags.get("--port") ?? "8917");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new UsageError("--port must be a TCP port");
  const { checks, host } = await collectVerification(
    {
      part: part as "app" | "all",
      runtimeParameterArn: need(flags, "--runtime-parameter"),
      environment,
      primaryPool: primary,
      generation,
      pools: (flags.get("--pools") ?? primary).split(",").map((p) => p.trim()).filter((p) => p.length > 0),
      port,
      evidenceDir: flags.has("--no-evidence") ? null : need(flags, "--evidence"),
      flipRecordFile: flags.get("--flip-record") ?? null,
      gameGenerations: gameGenerationsOf(flags, generation),
      pageActions: actionListOf(flags, "--page-actions"),
      ticketActions: actionListOf(flags, "--ticket-actions"),
      topology: hostOptions.topology,
      ...(hostOptions.host === undefined ? {} : { host: hostOptions.host }),
    },
    deps,
  );
  if (record !== undefined) writeVerifyRecord(record, run, part, environment, generation, checks, deps.now(), hostOptions.topology);
  /* COST-2A: the host evidence summary (machine- and human-readable), beside the terminal report. */
  if (hostOptions.reportDir !== null && host !== undefined && hostOptions.topology !== "ecs") {
    const written = writeHostReport(hostOptions.reportDir, { topology: hostOptions.topology, environment, generation, at: deps.now(), facts: hostFacts(need(flags, "--evidence"), host), checks });
    deps.out(`the host evidence: ${written.json} (${HOST_REPORT_FORMAT}) and ${written.markdown}`);
  }
  return report(deps.out, checks);
}

/* ------------------------------------------------------------------ */
/* generation-gate (LIVE-6 L6-2; L6-4 §12.2)                            */
/* ------------------------------------------------------------------ */

/**
 * The GENERATION SWITCH's gate, read-only: the serving runtime documents may move from N / g<N> to N+1 / g<N+1> ONLY once
 * `npm run recovery -- appgen-adopt` has settled `committed` or `already-adopted` for exactly that generation, table and
 * restore. Checked with L6-4's own strict readers and the tasks' own startup rules -- never a second model:
 *   - APPGEN (strict `readAppGeneration`) is at N+1, ADOPTED (not the bootstrap form), from N, for exactly this table and
 *     restore, and its history item `APPGEN#HISTORY/GEN#<N+1>` carries the SAME claim (the adoption's one transaction
 *     landed: a half-settled or another adoption is refused);
 *   - the table's SYSTEM/GENERATION passes `generationMarkerProblem` and `adoptionBindingProblem` exactly as a task will
 *     before it takes its pool.
 * Exit 0 ("GATE OPEN") prints the Terraform `generation_adoption` value the app stack's plan requires; anything else is 1
 * and nothing about the switch may proceed. The current runtime document names the environment, region and ledger.
 */
export async function generationGateCommand(argv: readonly string[], deps: DeployDeps): Promise<number> {
  const flags = parseFlags(argv, ["--runtime-parameter", "--environment", "--generation", "--restore-id", "--game-table", "--record"], []);
  const environment = environmentOf(need(flags, "--environment"));
  const next = generationOf(need(flags, "--generation"));
  const restoreId = need(flags, "--restore-id");
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(restoreId)) throw new UsageError("--restore-id is the restore's id (^[a-z0-9][a-z0-9-]{2,63}$)");
  const table = flags.get("--game-table") ?? expectedNames(environment, next).gameTable;
  if (table !== expectedNames(environment, next).gameTable) throw new UsageError(`--game-table ${table} is not the convention's ${expectedNames(environment, next).gameTable}`);
  const startup = await loadAwsStartup({ argv: [], env: { GS_AWS_CONFIG_PARAMETER: need(flags, "--runtime-parameter") }, serverMode: "production", parameters: deps.parameters });
  if (startup.config.environment !== environment) throw new UsageError(`the runtime document is for ${startup.config.environment}, not ${environment}`);
  const from = startup.config.generation;
  if (next <= from) throw new UsageError(`--generation ${next} is not ahead of the serving generation ${from}`);
  const { clients, tables } = clientsFor(deps, startup);
  const physical = deps.tables?.({ gameTable: table, identityTable: startup.config.identityTable, ledgerArn: startup.config.ledger.arn }).game ?? table;
  const checks: GateCheck[] = []; // a gate's record: pass / fail / skipped (never not-evaluated)
  const check = (name: string, ok: boolean, good: string, bad: string) => checks.push({ name, status: ok ? "pass" : "fail", detail: ok ? good : bad });
  const appgen = await readAppGeneration(clients.ledger, tables.ledger);
  const adoption = appgen?.adoption ?? null;
  check("APPGEN at the new generation", appgen !== null && appgen.current_generation === next, `current_generation ${next}`, `APPGEN is ${appgen === null ? "absent" : `at ${appgen.current_generation}`}: run \`npm run recovery -- appgen-adopt\` first (the switch never races ahead of the adoption)`);
  check(
    "APPGEN adopted exactly this restore",
    adoption !== null && adoption.game_table === table && adoption.restore_id === restoreId && adoption.previous_generation === from,
    `from ${from}, ${table}, restore ${restoreId}`,
    adoption === null ? "APPGEN is the bootstrap form (never adopted)" : `adopted ${adoption.game_table} (restore ${adoption.restore_id}) from ${adoption.previous_generation}`,
  );
  const history = await readAdoptionRecord(clients.ledger, tables.ledger, next);
  check("the adoption's history item (one transaction settled)", history !== null && adoption !== null && history.claim === adoption.claim && history.game_table === table && history.restore_id === restoreId, `APPGEN#HISTORY/GEN#${next}, claim ${history?.claim ?? "?"}`, history === null ? `no APPGEN#HISTORY/GEN#${next}: the adoption has not settled` : `the history item names ${history.game_table} / ${history.restore_id} / claim ${history.claim}, APPGEN ${adoption?.claim ?? "?"}`);
  let marker: GenerationMarker | null = null;
  try {
    marker = await readGenerationMarker(clients.app, physical);
  } catch (error) {
    check("SYSTEM/GENERATION of the new table", false, "", error instanceof Error ? error.message : String(error));
  }
  if (checks.every((c) => c.name !== "SYSTEM/GENERATION of the new table")) {
    const problem = generationMarkerProblem(marker, { generation: next, gameTable: table }) ?? adoptionBindingProblem(marker as GenerationMarker, adoption === null ? null : { game_table: adoption.game_table, restore_id: adoption.restore_id });
    check("SYSTEM/GENERATION of the new table (the tasks' startup rule)", problem === null, `generation ${next}, ${table}, restore ${restoreId}`, problem ?? "");
  }
  const exit = report(deps.out, checks);
  if (exit === EXIT_OK) {
    deps.out(`GATE OPEN: generation ${from} -> ${next} is adopted. In the app stack set generation = ${next}, keep ${from} in game_generations, and`);
    deps.out(`  generation_adoption = { generation = ${next}, game_table = "${table}", restore_id = "${restoreId}" }`);
  } else deps.out("GATE CLOSED: the runtime documents must NOT move to the new generation yet");
  /* LIVE-6 L6-5B (owner decision: the plan relies on THIS attestation): the gate's own verdict, preserved as evidence. */
  const recordFile = flags.get("--record");
  if (recordFile !== undefined) {
    writeGateRecord(recordFile, {
      format: GENERATION_GATE_FORMAT,
      environment,
      from_generation: from,
      verdict: exit === EXIT_OK ? "OPEN" : "CLOSED",
      attestation: exit === EXIT_OK ? { generation: next, game_table: table, restore_id: restoreId } : null,
      adoption_claim: adoption?.claim ?? null,
      checks,
      gated_at: new Date(deps.now()).toISOString(),
    });
    deps.out(`  the gate's record: ${recordFile} (${GENERATION_GATE_FORMAT}; keep it with the certification evidence)`);
  }
  return exit;
}

/* ------------------------------------------------------------------ */
/* relayer-rotation-gate (LIVE-6 L6-2 for L6-7; relayerRotation.ts)     */
/* ------------------------------------------------------------------ */

export async function relayerRotationGateCommand(argv: readonly string[], deps: DeployDeps): Promise<number> {
  const flags = parseFlags(argv, ["--runtime-parameter", "--environment", "--from-relayer", "--to-relayer", "--evidence", "--record"], []);
  const environment = environmentOf(need(flags, "--environment"));
  const from = need(flags, "--from-relayer");
  const to = need(flags, "--to-relayer");
  if (!RELAYER_ADDRESS.test(from) || !RELAYER_ADDRESS.test(to)) throw new UsageError("--from-relayer / --to-relayer are relayer account addresses");
  if (from === to) throw new UsageError("--from-relayer and --to-relayer are the same address: nothing rotates");
  const evidence = need(flags, "--evidence");
  const startup = await loadAwsStartup({ argv: [], env: { GS_AWS_CONFIG_PARAMETER: need(flags, "--runtime-parameter") }, serverMode: "production", parameters: deps.parameters });
  if (startup.config.environment !== environment) throw new UsageError(`the runtime document is for ${startup.config.environment}, not ${environment}`);
  const checks: GateCheck[] = []; // a gate's record: pass / fail / skipped (never not-evaluated)
  const check = (name: string, ok: boolean, good: string, bad: string) => checks.push({ name, status: ok ? "pass" : "fail", detail: ok ? good : bad });
  /* 1. The OLD configuration is still the active one (the change comes after this gate, never before it). */
  const configured = startup.escrowConfig?.relayer.address ?? null;
  check("the active configuration names the OLD relayer", configured === from, `relayer ${from}`, configured === null ? "the runtime document has no escrow: there is no relayer to rotate" : configured === to ? `the configuration ALREADY names ${to}: the rotation was applied before the old queue was proven empty -- restore the old configuration, then run this gate` : `the configuration names ${configured}, neither --from-relayer nor --to-relayer`);
  /* 2. Every pool drained: with no task running, nothing can add to the old queue between this proof and the change. */
  const pools = Object.keys(startup.config.routes).length > 0 ? Object.keys(startup.config.routes).sort() : [startup.config.pool];
  const manifest = readEvidence(evidence, POOL_EVIDENCE_FILES.manifest);
  checks.push(...(manifest.ok ? checkManifest(manifest.value, { environment, pools, now: deps.now(), maxAgeMs: 15 * 60_000 }) : [manifest.check]));
  const services = readEvidence(evidence, POOL_EVIDENCE_FILES.services);
  if (!services.ok) checks.push(services.check);
  else for (const pool of pools) checks.push(checkDrained(services.value, environment, pool));
  /* 3. RELAYQ#<old>: complete, strong, empty. Never the new address's queue. */
  const { clients, tables } = clientsFor(deps, startup);
  const queue = await relayQueueState(clients.app, tables.game, from);
  check(
    `RELAYQ#${from} empty (strongly consistent, every page)`,
    queue.state === "empty",
    "no entry: no open relayer work under the old address",
    queue.state === "open" ? `${queue.entries} open entr${queue.entries === 1 ? "y" : "ies"} (oldest: ${queue.oldest.join(", ")}): keep the old configuration active until the relayer drains them` : queue.state === "unknown" ? `UNKNOWN -- ${queue.detail}: refused (an unread queue is never taken for an empty one)` : "",
  );
  checks.push({ name: `RELAYQ#${to}`, status: "skipped", detail: "the new address's queue is never consulted: the old queue's emptiness is never inferred from it" });
  /* 4. LIVE-6 relayer rotation: the escrow contract's operator, read from the chain -- the old relayer (SetOperator still
     to come, inside this drained window) or already the new one; anything else is a deployment this rotation does not
     understand. Read only; recorded for the post-rotation proof and the rollback. */
  const operator = startup.escrowConfig === null ? { ok: false as const, detail: "no escrow configured" } : await chainOperator(deps, startup.escrowConfig);
  check(
    "the escrow contract's operator is the old or the new relayer (read from the chain)",
    operator.ok && (operator.control.operator === from || operator.control.operator === to),
    operator.ok ? `operator ${operator.control.operator} (${operator.control.operator === from ? "the OLD relayer: the admin's set_operator to the new address comes inside the drained window, after this gate" : "already the NEW relayer"}); admin ${operator.control.admin}` : "",
    operator.ok ? `the contract's operator is ${operator.control.operator}, neither --from-relayer nor --to-relayer: not a rotation this gate can prove` : `the contract's operator could not be read: ${operator.detail}`,
  );
  const exit = report(deps.out, checks);
  deps.out(exit === EXIT_OK ? `GATE OPEN: RELAYQ#${from} is proven empty with every pool drained. Now change the relayer configuration to ${to} (Terraform escrow), then start the pools; the primary's task takes the new relayer role.` : "GATE CLOSED: the relayer address must NOT change yet");
  /* LIVE-6 L6-5B: the gate's own verdict as evidence (L6-6: an unknown or closed gate fails certification). */
  const recordFile = flags.get("--record");
  if (recordFile !== undefined) {
    const capturedAt = manifest.ok ? (manifest.value as { captured_at?: unknown }).captured_at : undefined;
    writeGateRecord(recordFile, {
      format: ROTATION_GATE_FORMAT,
      environment,
      from_relayer: from,
      to_relayer: to,
      configured_relayer: configured,
      pools,
      evidence_captured_at: typeof capturedAt === "string" ? capturedAt : null,
      queue: queue.state,
      verdict: exit === EXIT_OK ? "OPEN" : "CLOSED",
      checks,
      gated_at: new Date(deps.now()).toISOString(),
      /* v2 (LIVE-6 relayer rotation): what the rotation must leave untouched, from the configuration judged above. */
      deployment: startup.escrowConfig === null ? null : deploymentIdentityOf(startup.escrowConfig),
      contract_operator: operator.ok ? operator.control.operator : null,
    });
    deps.out(`  the gate's record: ${recordFile} (${ROTATION_GATE_FORMAT}; keep it with the certification evidence)`);
  }
  return exit;
}

/** The contract's control fields from the chain, or why they could not be read (never thrown, never guessed). */
async function chainOperator(deps: DeployDeps, config: NonNullable<AwsStartup["escrowConfig"]>): Promise<{ readonly ok: true; readonly control: ContractControl } | { readonly ok: false; readonly detail: string }> {
  if (deps.juno === undefined) return { ok: false, detail: "no chain reader is bound in this build" };
  try {
    return { ok: true, control: await contractControl(deps.juno.rest(config), config) };
  } catch (error) {
    return { ok: false, detail: `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`.slice(0, 300) };
  }
}

/* ------------------------------------------------------------------ */
/* set-operator-plan (LIVE-6 relayer rotation; junoChain.ts)            */
/* ------------------------------------------------------------------ */

/** Base units as a decimal of the display unit (6 decimals, integer arithmetic): 8212500 -> "8.2125". */
const display = displayUnits;

export async function setOperatorPlanCommand(argv: readonly string[], deps: DeployDeps): Promise<number> {
  const flags = parseFlags(argv, ["--runtime-parameter", "--environment", "--to-relayer", "--to-relayer-key"], []);
  const environment = environmentOf(need(flags, "--environment"));
  const to = need(flags, "--to-relayer");
  if (!RELAYER_ADDRESS.test(to)) throw new UsageError("--to-relayer is a relayer account address");
  const startup = await loadAwsStartup({ argv: [], env: { GS_AWS_CONFIG_PARAMETER: need(flags, "--runtime-parameter") }, serverMode: "production", parameters: deps.parameters });
  if (startup.config.environment !== environment) throw new UsageError(`the runtime document is for ${startup.config.environment}, not ${environment}`);
  const config = startup.escrowConfig;
  if (config === null) throw new UsageError("the runtime document has no escrow: there is no operator to change");
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, good: string, bad: string) => checks.push({ name, status: ok ? "pass" : "fail", detail: ok ? good : bad });
  /* 1. Optional: the address is the one the prepared KMS key controls (no typo can become the contract's operator). */
  const keyArn = flags.get("--to-relayer-key");
  if (keyArn !== undefined) {
    const parsed = parseKmsKeyArn(keyArn);
    if ("problem" in parsed) throw new UsageError(`--to-relayer-key: ${parsed.problem}`);
    let derived: string | null = null;
    let problem = "";
    try {
      derived = addressOfPublicKey(compressedKeyFromSpki(await deps.kms(parsed.region).digest.getPublicKey(keyArn)), "juno");
    } catch (error) {
      problem = error instanceof Error ? error.message.slice(0, 200) : String(error);
    }
    check("the new relayer address is the one the prepared KMS key controls", derived === to, `${keyArn} controls ${to}`, derived === null ? `the key's public key could not be read (${problem})` : `${keyArn} controls ${derived}, not ${to}`);
  }
  /* 2. The contract on chain: its admin (who must sign) and its operator (what changes). */
  const operator = await chainOperator(deps, config);
  check("the contract's admin and operator (read from the chain)", operator.ok, operator.ok ? `admin ${operator.control.admin}; operator ${operator.control.operator}; ${operator.control.contract_name} ${operator.control.contract_version}${operator.control.paused ? "; PAUSED" : ""}` : "", operator.ok ? "" : operator.detail);
  /* 3. The account: it must exist on chain (a never-funded account cannot sign) and hold the one-game operational planning
     reserve (LIVE-6 L6-12D). Evaluated in EVERY case -- also when the contract's operator is already `to` (S2), where it
     is the active relayer's readiness check and still decides the exit. Fail-closed: unread is never ready. */
  const funding = relayerFunding(config);
  let account: "exists" | "absent" | string = "absent";
  let balance: bigint | null = null;
  if (deps.juno === undefined) account = "no chain reader is bound in this build";
  else {
    try {
      account = (await deps.juno.rest(config).account(to)) === null ? "absent" : "exists";
      balance = await deps.juno.balance(config, to);
    } catch (error) {
      account = error instanceof Error ? error.message.slice(0, 200) : String(error);
    }
  }
  check(
    `the relayer account exists on chain and holds at least the one-game planning reserve (${display(funding.floor)} ${config.symbol})`,
    account === "exists" && balance !== null && balance >= funding.floor,
    `${to}: ${balance === null ? "?" : display(balance)} ${config.symbol} (${String(balance)} ${funding.denom}) >= ${display(funding.floor)} ${config.symbol} (${String(funding.floor)} ${funding.denom})`,
    account === "exists"
      ? balance === null
        ? `${to} holds an unread balance: not ready (an unread balance is never enough)`
        : `${to} holds ${display(balance)} ${config.symbol} (${String(balance)} ${funding.denom}): send at least ${display(funding.floor - balance)} ${config.symbol} more before the pools restart and it can receive new money work`
      : account === "absent"
        ? `${to} does not exist on chain yet: fund it (a plain bank send of at least ${display(funding.floor)} ${config.symbol}) before the pools restart -- an account that never received funds cannot sign`
        : `the account could not be read: ${account}`,
  );
  const exit = report(deps.out, checks);
  const already = operator.ok && operator.control.operator === to;
  deps.out("");
  deps.out("One-game operational planning reserve (relayerFunding; a readiness policy, not a contract cap or an absolute maximum game cost):");
  for (const line of relayerFundingDerivation(funding, config.symbol)) deps.out(`  ${line}`);
  deps.out("  The ACTIVE relayer must hold it before it can receive new money work; the relayer's hold-and-page behaviour and operator replenishment cover the rest.");
  deps.out("  Rollback: the old relayer signs no transaction during the rollback itself; if a rollback is needed, fund the old relayer to this reserve BEFORE the rollback's pools restart and can receive new money work (not before the forward rotation).");
  if (already) {
    deps.out(`The contract's operator is ALREADY ${to}: no set_operator is needed.`);
    deps.out(`  This run doubles as the ACTIVE relayer's readiness check (S2): ${exit === EXIT_OK ? "READY -- the active relayer holds the planning reserve" : "NOT READY -- see the FAIL above (the active relayer must hold the planning reserve before it can receive new money work)"}.`);
  } else {
    deps.out("THE ADMIN'S TRANSACTION (signed and sent OUTSIDE this tool, by the contract admin -- never by a relayer key; nothing here signs):");
    deps.out(`  chain     ${config.chainId}`);
    deps.out(`  sender    ${operator.ok ? operator.control.admin : "<the contract admin: unread>"}   (Config.admin; admin_guard refuses any other sender, and any funds)`);
    deps.out(`  contract  ${config.contract}`);
    deps.out(`  msg       ${setOperatorMessage(to)}`);
    deps.out("  funds     none");
    deps.out(`  e.g.      junod tx wasm execute ${config.contract} '${setOperatorMessage(to)}' --from <the admin's key> --chain-id ${config.chainId} --node <an RPC endpoint> --gas auto --gas-adjustment 1.3 --gas-prices 0.075${funding.denom}`);
    deps.out("  WHEN      only inside the drained window: after `relayer-rotation-gate` is OPEN and before the pools restart on the new configuration.");
  }
  deps.out(`${exit === EXIT_OK ? "READY" : "NOT READY"}: set-operator-plan --to-relayer ${to}${already ? " (operator already set; active-relayer readiness)" : ""}`);
  return exit;
}

/* ------------------------------------------------------------------ */
/* signer-keys                                                          */
/* ------------------------------------------------------------------ */

export async function signerKeysCommand(argv: readonly string[], deps: DeployDeps): Promise<number> {
  const flags = parseFlags(argv, ["--relayer", "--settlement", "--admission"], []);
  const arns = { relayer: need(flags, "--relayer"), settlement: need(flags, "--settlement"), admission: need(flags, "--admission") };
  const regions = new Set<string>();
  for (const [purpose, arn] of Object.entries(arns)) {
    const parsed = parseKmsKeyArn(arn);
    if ("problem" in parsed) throw new UsageError(`--${purpose}: ${parsed.problem}`);
    regions.add(parsed.region);
  }
  if (regions.size !== 1) throw new UsageError("the three keys must be in one region (the Juno configuration's KMS region)");
  if (new Set(Object.values(arns)).size !== 3) throw new UsageError("the three keys must be three different keys");
  const kms = deps.kms([...regions][0]);
  const reader = kmsKeyReader(kms.sdk, kms.digest);
  const result: Record<string, Record<string, string>> = {};
  let failed = false;
  for (const [purpose, arn] of Object.entries(arns)) {
    const d = await reader.describe(arn);
    const ok = d.Arn === arn && d.KeyState === "Enabled" && d.KeySpec === "ECC_SECG_P256K1" && d.KeyUsage === "SIGN_VERIFY" && d.MultiRegion === false;
    if (!ok) {
      failed = true;
      deps.out(`FAIL  ${purpose} ${arn}: state ${d.KeyState}, spec ${d.KeySpec}, usage ${d.KeyUsage}, multi-region ${String(d.MultiRegion)}`);
      continue;
    }
    const compressed = compressedKeyFromSpki(await kms.digest.getPublicKey(arn));
    result[purpose] = { key_arn: arn, public_key_hex: compressed.toString("hex"), ...(purpose === "relayer" ? { address: addressOfPublicKey(compressed, "juno") } : {}) };
  }
  if (failed) return EXIT_FAILED;
  deps.out(JSON.stringify(result, null, 2));
  deps.out("For the app stack's `escrow`: relayer_address = relayer.address; settlement_key.public_key_hex; admission_key.public_key_hex. (Public material only.)");
  return EXIT_OK;
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                             */
/* ------------------------------------------------------------------ */

export const USAGE = [
  "usage:",
  "  awsDeploy bootstrap --runtime-parameter <SSM ARN> --environment <env> --primary-pool <pool> --generation <N> --by <who> [--apply | --check]",
  "  awsDeploy verify --runtime-parameter <SSM ARN> --environment <env> --primary-pool <pool> --generation <N> [--pools p1,p2] [--port 8917] (--evidence <dir> | --no-evidence) [--flip-record <file>] [--part app|all] [--game-generations 1,2] [--page-actions <arn,...>] [--ticket-actions <arn,...>] [--record <file>]",
  "  awsDeploy verify --topology (coexist | single-host) --runtime-parameter <SSM ARN> --environment <env> --primary-pool <pool> --generation <N> [--pools p1,p2] --evidence <host capture dir>",
  "                   --instance-id <i-...|none> --origin-hostname <dns> [--gs-origin <dns>] [--site-origin <dns>] [--expect-digest sha256:<hex>] [--expect-build <id>]",
  "                   [--budget required|not-required] [--instance-type <type>] [--emergency-ssh] [--juno-egress-ports <p,...>] [--allow-nat <nat-...>] [--allow-vpc-endpoint <vpce-...>]",
  "                   --alarm-actions <arn,...>|none [--allow-eip <eipalloc-...>] [--legacy-vpc <vpc-...>] [--legacy-pools <p,...>] [--max-evidence-age-minutes 30]",
  "                   [--game-generations 1,2] [--record <file>] [--report <dir>]   (COST-2A; exit 0 PASS, 1 FAIL, 3 NOT EVALUATED)",
  "  awsDeploy verify --part ledger --ledger-table-arn <ARN> --environment <env> --generation <N> [--record <file> --run-id <run>]",
  "  awsDeploy signer-keys --relayer <key ARN> --settlement <key ARN> --admission <key ARN>",
  "  awsDeploy generation-gate --runtime-parameter <serving SSM ARN> --environment <env> --generation <N+1> --restore-id <id> [--record <file>]",
  "  awsDeploy relayer-rotation-gate --runtime-parameter <SSM ARN> --environment <env> --from-relayer <old> --to-relayer <new> --evidence <dir> [--record <file>]",
  "  awsDeploy set-operator-plan --runtime-parameter <SSM ARN> --environment <env> --to-relayer <new> [--to-relayer-key <key ARN>]   (read-only: the admin's set_operator, never signed here)",
  "  awsDeploy stage-cert (prerequisite | certify) ...   LIVE-6 L6-6: the real-AWS staging certification (aws/deploy/staging/commands.ts)",
  "  awsDeploy stage-probe (task-role | edge | collect | flip-alarms | restore-alarms | restore-fencing) ...",
  "  awsDeploy migration-guard (ledger-host-authorize | host-create | edge-cutover | ecs-rollback | compute-none | ledger-task-deauthorize | ecr-lifecycle | nat) ...   COST-2B: offline plan / NAT evidence guards (aws/deploy/migration/)",
].join("\n");

/** LIVE-6 L6-6: more commands (the staging certification's), dispatched here so they share the refusals and exit codes. */
export type ExtraCommands = Readonly<Record<string, (argv: readonly string[]) => Promise<number>>>;

export async function runDeployCommand(argv: readonly string[], deps: DeployDeps, extra: ExtraCommands = {}): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "bootstrap") return await bootstrapCommand(rest, deps);
    if (command === "verify") return await verifyCommand(rest, deps);
    if (command === "signer-keys") return await signerKeysCommand(rest, deps);
    if (command === "generation-gate") return await generationGateCommand(rest, deps);
    if (command === "relayer-rotation-gate") return await relayerRotationGateCommand(rest, deps);
    if (command === "set-operator-plan") return await setOperatorPlanCommand(rest, deps);
    if (command === "migration-guard") return await migrationGuardCommand(rest, deps.out);
    if (command !== undefined && Object.prototype.hasOwnProperty.call(extra, command)) return await extra[command](rest);
    deps.out(USAGE);
    return EXIT_USAGE;
  } catch (error) {
    if (error instanceof UsageError) {
      deps.out(`REFUSED: ${error.message}`);
      return EXIT_USAGE;
    }
    const message = error instanceof Error ? error.message : String(error);
    deps.out(`REFUSED: ${message.slice(0, 600)}`);
    return (error as { name?: string } | null)?.name === "AwsStartupError" ? EXIT_USAGE : EXIT_FAILED;
  }
}
