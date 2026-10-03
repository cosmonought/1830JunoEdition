// server/src/aws/deploy/hostcert/commands.ts
//
// ==================================================================
//  COST-2C: `npm run awsDeploy -- host-cert <scenario> ...` -- THE MUTATING SINGLE-HOST CERTIFICATION DRILLS
// ==================================================================
//
//   awsDeploy host-cert <scenario>
//       --run-id <run>                      lower-case, 6-40 characters (names the lock, the recorder, the rival)
//       --acknowledge-mutating-drill <scenario>   the SAME scenario name: an explicit acknowledgement, per scenario
//       --environment staging[-*]           --runtime-parameter <the pool's SSM document ARN>
//       --generation 1 --pool p1 --game-table gs-staging-game-g1
//       --instance-id i-...                 the host (the single-host stack's `instance_id` output)
//       --digest sha256:<64 hex> --build <build id>   the release the host serves (and is redeployed)
//       --source-commit <40 hex>            the reviewed commit this tool runs from (recorded)
//       --operator <label>                  who runs it (recorded in the lock and the evidence)
//       --evidence <dir>                    where host-cert-<scenario>-<run>.json is written (create-once)
//       [--region <r>]                      default: the runtime document's
//       [--ecs-cluster <name>]              default: gs-<environment> (absent cluster = retired = 0 tasks)
//       [--reclaim-stale-lock <run>]        stale-lock recovery: names the EXPIRED holder exactly (drillLock.ts)
//       [--before <file>]                   replacement-after: replacement-before's evidence record
//       [--stale-instance-id i-...]         replacement-after: the old host, kept reachable for the stale-host proof
//       --host-transport-profile <profile>  RECON-1: the AWS CLI profile of the HOST-DEPLOY principal (the one that runs
//                                           `gs-host deploy`): SSM Run Command on the host, the EC2 / ECS reads
//
//   scenarios: graceful-stop (F7) | crash-restart (F8) | reboot-restart (F8) | duplicate-preflight (F9a) |
//              duplicate-fence (F9b) | replacement-before | replacement-after   (`scenarios.ts`)
//
//   Exit: 0 PASS; 1 FAIL; 2 usage; 3 NOT EVALUATED (offline evidence always ends here, or an unread step); 4 REFUSED
//   (the precheck did not pass: nothing was mutated). There is no --force: every precondition is checked, every time.
//
// Credentials (RECON-1, two principals, NO new IAM):
//   the HOST TRANSPORT (AWS CLI: ssm send-command AWS-RunShellScript on the instance, ssm get-command-invocation,
//     ec2 describe-instances / describe-addresses, ecs list-tasks) runs ONLY under --host-transport-profile -- the
//     host-deploy principal, whose SSM authority on the host already exists for `gs-host deploy` (COST-1);
//   the CONTROL PLANE (SDK: the runtime document's GetParameter, the game table's reads and the drill lock's PutItem in
//     OPRUN#host-cert, the identity-writer role item, the ledger's APPGEN and FENCE#relayer) runs on the default chain --
//     the operator role gs-<env>-operator, whose grants already cover exactly that (pinned by hostCert.test.ts and
//     recon1AuthorizationGates.test.ts); it gains NO SSM / EC2 authority.
// Nothing here prints a credential, an SSM parameter's value, or server.env.

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

import { clientsFor, environmentOf, generationOf, loadAndMatch, need, parseFlags, UsageError, type DeployDeps } from "../commands";
import { obj, readEvidence, RUN_ID, writeRecord } from "../staging/evidence";
import { readGenerationEvidence } from "../staging/recovery";
import { CLI_PROFILE } from "./awsCliTransport";
import type { HostCertReaders } from "./controlPlane";
import { LOCK_FORMAT, type LockHolder } from "./drillLock";
import { BUILD, DIGEST, HOST_SCRIPT_NAMES } from "./hostOps";
import { HOST_CERT_FORMAT, runDrill, SCENARIOS, type DrillInput, type ReplacementBaseline, type Scenario, type Timing } from "./scenarios";
import type { HostCertWorld } from "./transport";
import { EXIT_FAIL, EXIT_NOT_EVALUATED, EXIT_PASS, EXIT_REFUSED, EXIT_USAGE } from "./verdict";

export interface HostCertDeps {
  /** The world for `region`, its host transport under `transportProfile` (production: `productionHostCertWorld`; tests: a
   *  fake -- never live). */
  readonly world: (region: string, transportProfile: string) => HostCertWorld;
  /** The deployment's readers (tools/awsDeploy.ts); absent: every authority read is NOT EVALUATED (and the precheck refuses). */
  readonly readers: HostCertReaders | undefined;
  /** The repository root (the reviewed unit and host scripts are hashed from infra/aws/modules/single-host/files). */
  readonly repository: string;
  /** Tests only. */
  readonly timing?: Partial<Timing>;
  readonly lockClaim?: string;
}

export const HOST_CERT_USAGE = [
  "usage:",
  `  awsDeploy host-cert (${Object.keys(SCENARIOS).join(" | ")}) --run-id <run> --acknowledge-mutating-drill <the same scenario> --environment staging --runtime-parameter <SSM ARN> --generation 1 --pool p1 --game-table <g1 table> --instance-id <i-...> --digest <sha256:...> --build <id> --source-commit <40 hex> --operator <label> --evidence <dir> [--region <r>] [--ecs-cluster <name>] [--reclaim-stale-lock <run>] [--before <file>] [--stale-instance-id <i-...>] --host-transport-profile <the host-deploy principal's AWS CLI profile>`,
  ...Object.values(SCENARIOS).map((s) => `      ${s.name.padEnd(20)} ${s.property.padEnd(12)} ${s.disruptive ? "DISRUPTIVE" : "non-disruptive"}${s.quiet ? ", needs 0 money games + RELAYQ empty" : ""}: ${s.summary}`),
].join("\n");

const INSTANCE = /^i-[0-9a-f]{8,17}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const OPERATOR = /^[A-Za-z0-9._@-]{1,64}$/;
const TABLE = /^[A-Za-z0-9_.-]{3,255}$/;
const POOL = /^[a-z0-9][a-z0-9-]{0,15}$/;

export const evidenceFileOf = (scenario: Scenario, run: string): string => `host-cert-${scenario}-${run}.json`;

/** SHA-256 of the reviewed unit and host scripts, LF line endings (as the host receives them through cloud-init). */
export function expectedHostFiles(repository: string): Record<string, string> {
  const base = path.join(repository, "infra", "aws", "modules", "single-host", "files");
  const out: Record<string, string> = {};
  const hash = (file: string): string => createHash("sha256").update(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"), "utf8").digest("hex");
  out["gs-server.service"] = hash(path.join(base, "systemd", "gs-server.service"));
  for (const name of HOST_SCRIPT_NAMES) out[name] = hash(path.join(base, "bin", name));
  return out;
}

/** replacement-before's record, as replacement-after needs it (its own format, this run, the lock it still holds). */
export function replacementBaselineOf(file: string, run: string, environment: string): ReplacementBaseline {
  const dir = path.dirname(file);
  const read = readEvidence(dir, path.basename(file), { ownRecord: true });
  if (!read.ok) throw new UsageError(`--before: ${read.problem}`);
  const r = obj(read.value);
  if (r.format !== HOST_CERT_FORMAT || r.scenario !== "replacement-before") throw new UsageError(`--before is ${String(r.format)} ${String(r.scenario)}, not a replacement-before record`);
  if (r.run_id !== run) throw new UsageError(`--before is run ${String(r.run_id)}; replacement-after must continue the SAME run (--run-id ${String(r.run_id)})`);
  if (r.environment !== environment) throw new UsageError(`--before is for ${String(r.environment)}`);
  if (r.refused === true || r.verdict === "FAIL") throw new UsageError("--before was refused or FAILED: the replacement has no valid baseline");
  const b = obj(obj(r.facts).replacement_baseline);
  const lock = obj(b.lock);
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
  const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const holder: LockHolder | null =
    s(lock.run) === run && s(lock.claim) !== null && n(lock.expires_at) !== null && n(lock.started_at) !== null && lock.outcome === "held"
      ? { run, scenario: s(lock.scenario) ?? "replacement-before", instance: s(lock.instance) ?? "", operator: s(lock.operator) ?? "", started_at: n(lock.started_at) as number, expires_at: n(lock.expires_at) as number, outcome: "held", claim: s(lock.claim) as string, source_commit: s(lock.source_commit) ?? "" }
      : null;
  const pool = n(b.pool_epoch);
  const identity = n(b.identity_epoch);
  if (holder === null || s(b.instance) === null || s(b.task) === null || pool === null || identity === null || s(b.expected_ip) === null || n(b.finished_at_ms) === null) throw new UsageError(`--before has no complete replacement baseline (lock format ${LOCK_FORMAT})`);
  return { run, environment, instance: s(b.instance) as string, expected_ip: s(b.expected_ip) as string, task: s(b.task) as string, pool_epoch: pool, identity_epoch: identity, relayer_epoch: n(b.relayer_epoch), lock: holder, finished_at_ms: n(b.finished_at_ms) as number };
}

export async function hostCertCommand(argv: readonly string[], deps: DeployDeps, host: HostCertDeps): Promise<number> {
  const [scenarioArg, ...rest] = argv;
  try {
    if (scenarioArg === undefined || !Object.prototype.hasOwnProperty.call(SCENARIOS, scenarioArg)) throw new UsageError(`unknown scenario ${JSON.stringify(scenarioArg ?? "")}`);
    const scenario = scenarioArg as Scenario;
    const flags = parseFlags(rest, ["--run-id", "--acknowledge-mutating-drill", "--environment", "--runtime-parameter", "--generation", "--pool", "--game-table", "--instance-id", "--digest", "--build", "--source-commit", "--operator", "--evidence", "--region", "--ecs-cluster", "--reclaim-stale-lock", "--before", "--stale-instance-id", "--host-transport-profile"], []);
    const run = need(flags, "--run-id");
    if (!RUN_ID.test(run)) throw new UsageError("--run-id must match ^[a-z0-9][a-z0-9-]{5,39}$");
    if (need(flags, "--acknowledge-mutating-drill") !== scenario) throw new UsageError(`--acknowledge-mutating-drill must name THIS scenario (${scenario}): an explicit acknowledgement that it mutates the staging host`);
    const environment = environmentOf(need(flags, "--environment"));
    if (!/^staging(-[a-z0-9-]{1,24})?$/.test(environment)) throw new UsageError("host-cert runs only against a staging environment (staging or staging-*)");
    const generation = generationOf(need(flags, "--generation"));
    const pool = need(flags, "--pool");
    if (!POOL.test(pool)) throw new UsageError("--pool is a pool id");
    const gameTable = need(flags, "--game-table");
    if (!TABLE.test(gameTable)) throw new UsageError("--game-table is a table name");
    const instanceId = need(flags, "--instance-id");
    if (!INSTANCE.test(instanceId)) throw new UsageError("--instance-id is an EC2 instance id (i-...)");
    const digest = need(flags, "--digest");
    if (!DIGEST.test(digest)) throw new UsageError("--digest is sha256:<64 hex>");
    const build = need(flags, "--build");
    if (!BUILD.test(build)) throw new UsageError("--build must match ^[A-Za-z0-9._-]{1,128}$");
    const sourceCommit = need(flags, "--source-commit");
    if (!COMMIT.test(sourceCommit)) throw new UsageError("--source-commit is the reviewed commit's 40-hex id");
    const operator = need(flags, "--operator");
    if (!OPERATOR.test(operator)) throw new UsageError("--operator must match ^[A-Za-z0-9._@-]{1,64}$");
    const evidence = need(flags, "--evidence");
    const transportProfile = need(flags, "--host-transport-profile");
    if (!CLI_PROFILE.test(transportProfile)) throw new UsageError("--host-transport-profile names the host-deploy principal's AWS CLI profile ([A-Za-z0-9._-], at most 64)");
    const reclaim = flags.get("--reclaim-stale-lock") ?? null;
    if (reclaim !== null && !RUN_ID.test(reclaim)) throw new UsageError("--reclaim-stale-lock names a run id");
    if (reclaim !== null && scenario === "replacement-after") throw new UsageError("replacement-after continues its own lock (--before); it never reclaims one");
    const stale = flags.get("--stale-instance-id") ?? null;
    if (stale !== null && (!INSTANCE.test(stale) || scenario !== "replacement-after")) throw new UsageError("--stale-instance-id is an instance id, for replacement-after only");
    const beforeFile = flags.get("--before");
    if ((beforeFile !== undefined) !== (scenario === "replacement-after")) throw new UsageError("--before belongs to replacement-after (and replacement-after needs it)");
    const outFile = evidenceFileOf(scenario, run);
    if (fs.existsSync(path.join(evidence, outFile))) throw new UsageError(`${path.join(evidence, outFile)} already exists: evidence is create-once (a new run id for a new drill)`);
    const startup = await loadAndMatch(deps, need(flags, "--runtime-parameter"), { environment, pool, generation });
    const region = flags.get("--region") ?? startup.config.region;
    const ecsCluster = flags.get("--ecs-cluster") ?? `gs-${environment}`;
    const { clients, tables } = clientsFor(deps, startup);
    const hostReaders = host.readers;
    const replacementBefore = beforeFile === undefined ? undefined : replacementBaselineOf(beforeFile, run, environment);
    const input: DrillInput = { scenario, run, environment, generation, pool, gameTable, instanceId, digest, build, sourceCommit, operator, ecsCluster, reclaimStaleLock: reclaim, ...(replacementBefore !== undefined ? { replacementBefore } : {}), staleInstanceId: stale };
    deps.out(`host-cert ${scenario} (${SCENARIOS[scenario].property}) run ${run} on ${instanceId} (${environment}, g${generation}, ${pool}) -- ${SCENARIOS[scenario].disruptive ? "DISRUPTIVE" : "non-disruptive"}`);
    deps.out(`  credentials: host transport = AWS CLI profile ${transportProfile} (the host-deploy principal); control plane and lock = the default chain (the operator role)`);
    const result = await runDrill(input, {
      world: host.world(region, transportProfile),
      readers: host.readers,
      target: { clients, tables, pool, relayer: startup.escrowConfig?.relayer.address ?? null },
      generationEvidence: () => readGenerationEvidence(hostReaders?.recovery, clients, { game: tables.game, ledger: tables.ledger }),
      document: { environment: startup.config.environment, pool: startup.config.pool, generation: startup.config.generation, gameTable: startup.config.gameTable, escrowNetwork: startup.escrowConfig?.networkClass ?? null },
      expectedFiles: expectedHostFiles(host.repository),
      lock: { client: clients.app, table: tables.game, ...(host.lockClaim !== undefined ? { claim: host.lockClaim } : {}) },
      ...(host.timing !== undefined ? { timing: host.timing } : {}),
    });
    const phases = obj(result.record.phases);
    const listOf = (v: unknown): Array<{ name: string; status: string; detail: string }> => (Array.isArray(v) ? (v as Array<{ name: string; status: string; detail: string }>) : Array.isArray(obj(v).checks) ? (obj(v).checks as Array<{ name: string; status: string; detail: string }>) : []);
    for (const phase of ["precheck", "mutation", "observation", "cleanup", "postcheck"]) {
      for (const c of listOf(phases[phase])) deps.out(`${c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "NOT EVALUATED"}  [${phase}] ${c.name} -- ${c.detail}`);
    }
    let written: string;
    try {
      written = writeRecord(evidence, outFile, result.record);
    } catch (error) {
      deps.out(`FAIL  the evidence record could not be written: ${error instanceof Error ? error.message : String(error)}`);
      deps.out(`COST-2C HOST CERT ${scenario}: FAIL (no evidence)`);
      return EXIT_FAIL;
    }
    deps.out(`  evidence: ${written}`);
    deps.out(`COST-2C HOST CERT ${scenario}: ${result.refused ? "REFUSED (nothing was mutated) -- NOT EVALUATED" : result.verdict}`);
    if (result.refused) return EXIT_REFUSED;
    return result.verdict === "PASS" ? EXIT_PASS : result.verdict === "FAIL" ? EXIT_FAIL : EXIT_NOT_EVALUATED;
  } catch (error) {
    if (error instanceof UsageError) {
      deps.out(`REFUSED: ${error.message}`);
      deps.out(HOST_CERT_USAGE);
      return EXIT_USAGE;
    }
    throw error;
  }
}
