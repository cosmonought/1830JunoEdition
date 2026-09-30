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
// Credentials: the SDK's default chain (the operator's profile or the pipeline's role -- the task's refusal of static
// keys is the RUNTIME's rule, not this tool's). Regions: the runtime document's and the ARNs', never the environment's.
// Nothing here prints a credential or a document's content; nothing but `bootstrap --apply` writes.

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { KMSClient } from "@aws-sdk/client-kms";

import { addressOfPublicKey } from "../../escrow/juno/cosmosTx";
import { compressedKeyFromSpki, type KmsClient } from "../../escrow/juno/signer";
import { parseDynamoTableArn, parseKmsKeyArn, parseSsmParameterArn } from "../arns";
import { loadAwsStartup, type AwsStartup } from "../runtime/awsMain";
import type { ParameterSource } from "../runtime/configSource";
import { AWS_RUNTIME_CONFIG_FORMAT_V2 } from "../runtime/runtimeConfig";
import { readFlipRecordFile } from "../controlPlane/flipRecord";
import { checkDrained, checkManifest, POOL_EVIDENCE_FILES, readEvidence } from "../controlPlane/evidence";
import { RELAYER_ADDRESS, relayQueueState } from "./relayerRotation";
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

class UsageError extends Error {}

function parseFlags(argv: readonly string[], allowed: readonly string[], booleans: readonly string[]): Map<string, string> {
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

const need = (flags: Map<string, string>, name: string): string => {
  const value = flags.get(name);
  if (value === undefined) throw new UsageError(`${name} is required`);
  return value;
};

const generationOf = (text: string): number => {
  if (!/^[1-9][0-9]{0,15}$/.test(text) || !Number.isSafeInteger(Number(text))) throw new UsageError("--generation must be a positive whole number");
  return Number(text);
};

const ENVIRONMENT = /^[a-z][a-z0-9-]{0,31}$/;
const environmentOf = (text: string): string => {
  if (!ENVIRONMENT.test(text)) throw new UsageError("--environment must match ^[a-z][a-z0-9-]{0,31}$");
  return text;
};

function report(out: (line: string) => void, checks: readonly Check[]): number {
  for (const check of checks) out(`${check.status === "pass" ? "PASS" : check.status === "fail" ? "FAIL" : "SKIP"}  ${check.name} -- ${check.detail}`);
  const failed = checks.filter((c) => c.status === "fail").length;
  const skippedCount = checks.filter((c) => c.status === "skipped").length;
  out(`${failed === 0 ? "VERIFIED" : "NOT VERIFIED"}: ${checks.length - failed - skippedCount} passed, ${failed} failed, ${skippedCount} skipped (named above)`);
  return failed === 0 ? EXIT_OK : EXIT_FAILED;
}

/** The runtime document the task would read, by the task's own code; its identity must be what the caller named. */
async function loadAndMatch(deps: DeployDeps, arn: string, expect: { readonly environment: string; readonly pool: string; readonly generation: number }): Promise<AwsStartup> {
  const startup = await loadAwsStartup({ argv: [], env: { GS_AWS_CONFIG_PARAMETER: arn }, serverMode: "production", parameters: deps.parameters });
  const problems = checkRuntimeDocument(startup.config, expect).filter((c) => c.status === "fail");
  if (problems.length > 0) throw new UsageError(`the runtime document ${arn} (v${startup.configVersion}) is not the one asked for: ${problems.map((c) => c.detail).join("; ")}`);
  return startup;
}

function clientsFor(deps: DeployDeps, startup: AwsStartup): { readonly clients: BootstrapClients; readonly tables: { readonly game: string; readonly identity: string; readonly ledger: string } } {
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

export async function verifyCommand(argv: readonly string[], deps: DeployDeps): Promise<number> {
  const flags = parseFlags(argv, ["--runtime-parameter", "--environment", "--primary-pool", "--generation", "--pools", "--evidence", "--part", "--ledger-table-arn", "--port", "--flip-record"], ["--no-evidence"]);
  const part = flags.get("--part") ?? "app";
  if (!["app", "ledger", "all"].includes(part)) throw new UsageError("--part is app, ledger or all");
  const environment = environmentOf(need(flags, "--environment"));
  const generation = generationOf(need(flags, "--generation"));
  const names = expectedNames(environment, generation);
  const checks: Check[] = [];

  if (part === "ledger") {
    const arn = parseDynamoTableArn(need(flags, "--ledger-table-arn"));
    if ("problem" in arn) throw new UsageError(`--ledger-table-arn: ${arn.problem}`);
    if (arn.table !== names.ledgerTable) throw new UsageError(`--ledger-table-arn names ${arn.table}, not ${names.ledgerTable}`);
    const client = deps.dynamo(arn.region);
    const ledger = deps.tables?.({ gameTable: names.gameTable, identityTable: names.identityTable, ledgerArn: arn.arn }).ledger ?? arn.arn;
    checks.push(...checkTable("ledger table", await readTableEvidence(client, ledger, { backupsAndTtl: true }), { name: names.ledgerTable, ttlAttribute: null }));
    checks.push(...(await checkControlRecords({ app: client, ledger: client }, { gameTable: "-", ledgerTable: ledger, primaryPool: "p1", generation }, { appgen: true, routing: false })));
    checks.push(skipped("app account", "--part ledger checks the ledger account only; run --part app with the app account's credentials"));
    return report(deps.out, checks);
  }

  const arn = need(flags, "--runtime-parameter");
  const primary = need(flags, "--primary-pool");
  const pools = (flags.get("--pools") ?? primary).split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (!pools.includes(primary)) throw new UsageError("--pools must include the primary pool");
  const port = Number(flags.get("--port") ?? "8917");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new UsageError("--port must be a TCP port");
  if (flags.has("--evidence") === flags.has("--no-evidence")) throw new UsageError("name the control-plane evidence directory (--evidence <dir>, from infra/aws/scripts/capture-evidence) or skip it explicitly (--no-evidence)");

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
  const flipRecordFile = flags.get("--flip-record");
  if (flipRecordFile !== undefined) {
    const record = readFlipRecordFile(flipRecordFile);
    if ("problem" in record) checks.push({ name: "flip record", status: "fail", detail: record.problem });
    else {
      flip = { since: record.since, from: record.from, to: record.to, rollback: record.rollback };
      checks.push({ name: "flip record: primary", status: record.to === primary ? "pass" : "fail", detail: record.to === primary ? `the flip made ${record.to} primary (routing v${record.version})` : `the flip record names ${record.to}, --primary-pool is ${primary}` });
    }
  }

  const { clients, tables } = clientsFor(deps, startup);
  checks.push(...checkTable("game table", await readTableEvidence(clients.app, tables.game, { backupsAndTtl: true }), { name: names.gameTable, ttlAttribute: null }));
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

  if (flags.has("--no-evidence")) checks.push(skipped("control-plane evidence", "--no-evidence: task definitions, services, target group, ALB, edge and security groups NOT checked"));
  else checks.push(...checkEvidenceDirectory(need(flags, "--evidence"), { environment, pools, primaryPool: primary, port, runtimeParameterArns: runtimeArns, routes, flip, now: deps.now() }));
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
  const flags = parseFlags(argv, ["--runtime-parameter", "--environment", "--generation", "--restore-id", "--game-table"], []);
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
  const checks: Check[] = [];
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
  return exit;
}

/* ------------------------------------------------------------------ */
/* relayer-rotation-gate (LIVE-6 L6-2 for L6-7; relayerRotation.ts)     */
/* ------------------------------------------------------------------ */

export async function relayerRotationGateCommand(argv: readonly string[], deps: DeployDeps): Promise<number> {
  const flags = parseFlags(argv, ["--runtime-parameter", "--environment", "--from-relayer", "--to-relayer", "--evidence"], []);
  const environment = environmentOf(need(flags, "--environment"));
  const from = need(flags, "--from-relayer");
  const to = need(flags, "--to-relayer");
  if (!RELAYER_ADDRESS.test(from) || !RELAYER_ADDRESS.test(to)) throw new UsageError("--from-relayer / --to-relayer are relayer account addresses");
  if (from === to) throw new UsageError("--from-relayer and --to-relayer are the same address: nothing rotates");
  const evidence = need(flags, "--evidence");
  const startup = await loadAwsStartup({ argv: [], env: { GS_AWS_CONFIG_PARAMETER: need(flags, "--runtime-parameter") }, serverMode: "production", parameters: deps.parameters });
  if (startup.config.environment !== environment) throw new UsageError(`the runtime document is for ${startup.config.environment}, not ${environment}`);
  const checks: Check[] = [];
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
  const exit = report(deps.out, checks);
  deps.out(exit === EXIT_OK ? `GATE OPEN: RELAYQ#${from} is proven empty with every pool drained. Now change the relayer configuration to ${to} (Terraform escrow), then start the pools; the primary's task takes the new relayer role.` : "GATE CLOSED: the relayer address must NOT change yet");
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
  "  awsDeploy verify --runtime-parameter <SSM ARN> --environment <env> --primary-pool <pool> --generation <N> [--pools p1,p2] [--port 8917] (--evidence <dir> | --no-evidence) [--flip-record <file>] [--part app|all]",
  "  awsDeploy verify --part ledger --ledger-table-arn <ARN> --environment <env> --generation <N>",
  "  awsDeploy signer-keys --relayer <key ARN> --settlement <key ARN> --admission <key ARN>",
  "  awsDeploy generation-gate --runtime-parameter <serving SSM ARN> --environment <env> --generation <N+1> --restore-id <id>",
  "  awsDeploy relayer-rotation-gate --runtime-parameter <SSM ARN> --environment <env> --from-relayer <old> --to-relayer <new> --evidence <dir>",
].join("\n");

export async function runDeployCommand(argv: readonly string[], deps: DeployDeps): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "bootstrap") return await bootstrapCommand(rest, deps);
    if (command === "verify") return await verifyCommand(rest, deps);
    if (command === "signer-keys") return await signerKeysCommand(rest, deps);
    if (command === "generation-gate") return await generationGateCommand(rest, deps);
    if (command === "relayer-rotation-gate") return await relayerRotationGateCommand(rest, deps);
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
