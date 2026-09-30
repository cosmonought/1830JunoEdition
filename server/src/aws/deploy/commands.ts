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
//       refuses a mis-pointed document. Then APPGEN and SYSTEM/ROUTING (`bootstrap.ts`):
//         (default)  DRY RUN: both records' state and what --apply would create; exit 1 if either is incompatible
//         --apply    create what is absent (APPGEN, then the routing); exit 0 bootstrapped, 1 refused (nothing
//                    written), 3 unknown outcome (run it again: it can never write twice)
//         --check    exit 0 only if both already hold the desired state
//
//   verify      --runtime-parameter <SSM ARN> --environment <env> --primary-pool <pool> --generation <N>
//               [--pools p1,p2] (--evidence <dir> | --no-evidence) [--part app|all]
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
// Credentials: the SDK's default chain (the operator's profile or the pipeline's role -- the task's refusal of static
// keys is the RUNTIME's rule, not this tool's). Regions: the runtime document's and the ARNs', never the environment's.
// Nothing here prints a credential or a document's content; nothing but `bootstrap --apply` writes.

import * as path from "path";

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { KMSClient } from "@aws-sdk/client-kms";

import { addressOfPublicKey } from "../../escrow/juno/cosmosTx";
import { compressedKeyFromSpki, type KmsClient } from "../../escrow/juno/signer";
import { parseDynamoTableArn, parseKmsKeyArn, parseSsmParameterArn } from "../arns";
import { loadAwsStartup, type AwsStartup } from "../runtime/awsMain";
import type { ParameterSource } from "../runtime/configSource";
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

export function report(out: (line: string) => void, checks: readonly Check[]): number {
  for (const check of checks) out(`${check.status === "pass" ? "PASS" : check.status === "fail" ? "FAIL" : "SKIP"}  ${check.name} -- ${check.detail}`);
  const failed = checks.filter((c) => c.status === "fail").length;
  const skippedCount = checks.filter((c) => c.status === "skipped").length;
  out(`${failed === 0 ? "VERIFIED" : "NOT VERIFIED"}: ${checks.length - failed - skippedCount} passed, ${failed} failed, ${skippedCount} skipped (named above)`);
  return failed === 0 ? EXIT_OK : EXIT_FAILED;
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
  const target: BootstrapTarget = { gameTable: tables.game, ledgerTable: tables.ledger, primaryPool: pool, generation, by };
  deps.out(`bootstrap ${environment}: runtime document ${arn} v${startup.configVersion}; game ${startup.config.gameTable}; ledger ${startup.config.ledger.arn}; primary pool ${pool}; generation ${generation}`);

  if (!flags.has("--apply")) {
    const inspection = await inspectBootstrap(clients, target);
    deps.out(stateLine("APPGEN", inspection.appgen));
    deps.out(stateLine("SYSTEM/ROUTING", inspection.routing));
    const plan = bootstrapPlan(inspection);
    if (flags.has("--check")) {
      const done = inspection.appgen.kind === "matches" && inspection.routing.kind === "matches";
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
    deps.out(stateLine("SYSTEM/ROUTING", outcome.inspection.routing));
    if (outcome.kind === "refused") {
      for (const reason of outcome.reasons) deps.out(`  REFUSED: ${reason}`);
      deps.out("NOT BOOTSTRAPPED: nothing incompatible was overwritten");
      return EXIT_FAILED;
    }
    deps.out(`BOOTSTRAPPED: APPGEN ${outcome.appgen}, SYSTEM/ROUTING ${outcome.routing}`);
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
}

/** The verifier's checks for the app half (and, with `part: "all"`, the ledger's PITR and TTL too). Read-only. Returns the
 *  parsed documents as well (the certification needs the escrow configuration and the pools' runtime document ARNs). */
export async function collectVerification(options: VerifyOptions, deps: DeployDeps): Promise<{ readonly checks: Check[]; readonly startup: AwsStartup; readonly runtimeArns: ReadonlyMap<string, string> }> {
  const { part, environment, generation, primaryPool: primary, pools, port } = options;
  const arn = options.runtimeParameterArn;
  const names = expectedNames(environment, generation);
  const checks: Check[] = [];
  if (!pools.includes(primary)) throw new UsageError("--pools must include the primary pool");

  /* The documents, by the task's own code, for every pool. */
  const startup = await loadAndMatch(deps, arn, { environment, pool: primary, generation });
  checks.push({ name: `runtime document ${primary}`, status: "pass", detail: `v${startup.configVersion} parsed by the task's own code (loadAwsStartup)${startup.escrowConfig === null ? "; escrow null" : `; Juno configuration v${startup.escrowConfigVersion} parsed and checked for AWS storage`}` });
  const runtimeArns = new Map<string, string>([[primary, arn]]);
  for (const pool of pools.filter((p) => p !== primary)) {
    const sibling = siblingRuntimeParameter(arn, environment, pool);
    runtimeArns.set(pool, sibling);
    try {
      const other = await loadAndMatch(deps, sibling, { environment, pool, generation });
      checks.push({ name: `runtime document ${pool}`, status: "pass", detail: `v${other.configVersion}` });
      const same = other.config.gameTable === startup.config.gameTable && other.config.identityTable === startup.config.identityTable && other.config.ledger.arn === startup.config.ledger.arn && JSON.stringify(other.config.escrow) === JSON.stringify(startup.config.escrow);
      checks.push({ name: `runtime document ${pool}: same tables and escrow`, status: same ? "pass" : "fail", detail: same ? "as the primary's" : "names other tables or another escrow configuration than the primary's" });
    } catch (error) {
      checks.push({ name: `runtime document ${pool}`, status: "fail", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  const { clients, tables } = clientsFor(deps, startup);
  checks.push(...checkTable("game table", await readTableEvidence(clients.app, tables.game, { backupsAndTtl: true }), { name: names.gameTable, ttlAttribute: null }));
  checks.push(...checkTable("identity table", await readTableEvidence(clients.app, tables.identity, { backupsAndTtl: true }), { name: names.identityTable, ttlAttribute: "ttl" }));
  const ledgerChecks = checkTable("ledger table", await readTableEvidence(clients.ledger, tables.ledger, { backupsAndTtl: part === "all" }), { name: names.ledgerTable, ttlAttribute: null });
  checks.push(...(part === "all" ? ledgerChecks : ledgerChecks.filter((c) => !c.name.endsWith(": PITR") && !c.name.endsWith(": TTL"))));
  if (part === "app") checks.push(skipped("ledger table: PITR and TTL", "not readable across accounts: run --part ledger with the ledger account's credentials"));
  checks.push(...(await checkControlRecords(clients, { gameTable: tables.game, ledgerTable: tables.ledger, primaryPool: primary, generation }, { appgen: true, routing: true })));

  if (startup.escrowConfig === null) checks.push(skipped("KMS signing keys", "escrow is null in the runtime document"));
  else {
    const region = startup.escrowConfig.kmsRegion;
    if (region === null) checks.push({ name: "KMS signing keys", status: "fail", detail: "the escrow configuration names no KMS region" });
    else {
      const kms = deps.kms(region);
      checks.push(...(await checkSigningKeys(startup.escrowConfig, kmsKeyReader(kms.sdk, kms.digest))));
    }
  }

  if (options.evidenceDir === null) checks.push(skipped("control-plane evidence", "--no-evidence: task definitions, services, target group, ALB, edge and security groups NOT checked"));
  else checks.push(...checkEvidenceDirectory(options.evidenceDir, { environment, pools, primaryPool: primary, port, runtimeParameterArns: runtimeArns }));
  return { checks, startup, runtimeArns };
}

/** `verify --record <file>`: the checks as a record (the certification reads the ledger half from one). */
function writeVerifyRecord(file: string, run: string | null, part: string, environment: string, generation: number, checks: readonly Check[], now: number): void {
  const record = { format: VERIFY_RECORD_FORMAT, run_id: run, part, environment, generation, at: new Date(now).toISOString(), verdict: checks.every((c) => c.status === "pass") ? "PASS" : "FAIL", checks };
  const dir = path.dirname(path.resolve(file));
  writeRecord(dir, path.basename(file), record);
}

export async function verifyCommand(argv: readonly string[], deps: DeployDeps): Promise<number> {
  const flags = parseFlags(argv, ["--runtime-parameter", "--environment", "--primary-pool", "--generation", "--pools", "--evidence", "--part", "--ledger-table-arn", "--port", "--record", "--run-id"], ["--no-evidence"]);
  const part = flags.get("--part") ?? "app";
  if (!["app", "ledger", "all"].includes(part)) throw new UsageError("--part is app, ledger or all");
  const environment = environmentOf(need(flags, "--environment"));
  const generation = generationOf(need(flags, "--generation"));
  const names = expectedNames(environment, generation);
  const record = flags.get("--record");
  const run = flags.get("--run-id") ?? null;

  if (part === "ledger") {
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

  if (flags.has("--evidence") === flags.has("--no-evidence")) throw new UsageError("name the control-plane evidence directory (--evidence <dir>, from infra/aws/scripts/capture-evidence) or skip it explicitly (--no-evidence)");
  const primary = need(flags, "--primary-pool");
  const port = Number(flags.get("--port") ?? "8917");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new UsageError("--port must be a TCP port");
  const { checks } = await collectVerification(
    {
      part: part as "app" | "all",
      runtimeParameterArn: need(flags, "--runtime-parameter"),
      environment,
      primaryPool: primary,
      generation,
      pools: (flags.get("--pools") ?? primary).split(",").map((p) => p.trim()).filter((p) => p.length > 0),
      port,
      evidenceDir: flags.has("--no-evidence") ? null : need(flags, "--evidence"),
    },
    deps,
  );
  if (record !== undefined) writeVerifyRecord(record, run, part, environment, generation, checks, deps.now());
  return report(deps.out, checks);
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
  "  awsDeploy verify --runtime-parameter <SSM ARN> --environment <env> --primary-pool <pool> --generation <N> [--pools p1,p2] [--port 8917] (--evidence <dir> | --no-evidence) [--part app|all] [--record <file>]",
  "  awsDeploy verify --part ledger --ledger-table-arn <ARN> --environment <env> --generation <N> [--record <file> --run-id <run>]",
  "  awsDeploy signer-keys --relayer <key ARN> --settlement <key ARN> --admission <key ARN>",
  "  awsDeploy stage-cert (prerequisite | certify) ...   LIVE-6 L6-6: the real-AWS staging certification (aws/deploy/staging/commands.ts)",
  "  awsDeploy stage-probe (task-role | edge | collect) ...",
].join("\n");

/** LIVE-6 L6-6: more commands (the staging certification's), dispatched here so they share the refusals and exit codes. */
export type ExtraCommands = Readonly<Record<string, (argv: readonly string[]) => Promise<number>>>;

export async function runDeployCommand(argv: readonly string[], deps: DeployDeps, extra: ExtraCommands = {}): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "bootstrap") return await bootstrapCommand(rest, deps);
    if (command === "verify") return await verifyCommand(rest, deps);
    if (command === "signer-keys") return await signerKeysCommand(rest, deps);
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
