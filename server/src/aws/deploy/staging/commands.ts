// server/src/aws/deploy/staging/commands.ts
//
// ==================================================================
//  LIVE-6 L6-6: `npm run awsDeploy -- stage-cert | stage-probe` -- THE REAL-AWS STAGING CERTIFICATION'S COMMANDS
// ==================================================================
//
// ONE RUN, IN ORDER (infra/aws/README.md "Staging certification"; every file lands in ONE evidence directory):
//
//   1. infra/aws/scripts/capture-evidence ... <dir>                        read-only captures
//   2. stage-cert prerequisite --run-id R --evidence <dir> <verify flags> [--part app|all]
//        the L5-8 verifier (live, read-only) + the settled-deployment checks -> prerequisite.json; exit 0 only on PASS.
//        (Two-account form: `verify --part ledger ... --record <dir>/verify-ledger.json` with the ledger's credentials.)
//   3. infra/aws/scripts/run-task-probe ... R <dir> [--disposable-writes]   refuses unless prerequisite.json is PASS for R;
//        one certifier task on the primary's RUNNING definition, command overridden to
//          stage-probe task-role --run-id R ... [--disposable-writes L6CERT#R]
//        (the task role's IAM probe, KMS latency, and -- opted in -- the transaction probe), its log saved, then
//          stage-probe collect --run-id R --evidence <dir>                   the record, reassembled from the log
//   4. stage-probe edge --run-id R --evidence <dir> --base-url https://<distribution> --origin https://<allowed origin>
//        [--expected-client-ip <your public IP>]    (GS_CERT_SESSION_COOKIE: a staging account's session cookie value)
//      PHASE 1 REMAINDER (SINGLE_HOST_MIGRATION.md step 16): `--topology single-host --host-evidence <step 15b dir>
//        --instance-id <i-...> --origin-hostname <dns>` probes the SAME edge on the single host's path (CloudFront ->
//        Caddy), standing on the host's verified evidence instead of the ECS prerequisite / ALB attributes, and judges its
//        own record (edge-single-host-verdict.json; singleHostEdge.ts). The default (`--topology ecs`) is unchanged.
//   5. infra/aws/scripts/plan-evidence ... <dir>                            the ledger and app plans (never applied)
//   6. (replacement scenario) drain-pool ... <dir>, terraform apply, then capture-evidence again
//   7. capture-evidence ... <dir> again, then
//      stage-cert certify --run-id R --evidence <dir> <verify flags> --scenario read-only|replacement|restore-drill|
//                         flip-drill|relayer-rotation-drill [--replaced-pools p1] [--from-relayer <old> --to-relayer <new>]
//                         [--page-actions <arns>|none --ticket-actions <arns>|none] --commit <sha> [--repository <checkout>]
//      (LIVE-6 final convergence: the drills' evidence files -- flip-record.json, gate-generation.json,
//       gate-relayer-rotation.json, probe-flip-alarms.json, probe-restore-alarms.json -- are `drills.ts`'s)
//        -> certification.json, CERTIFICATION.txt, certification-manifest.json; stdout begins with the verdict line; exit 0
//           only on PASS.
//
// NOTHING HERE DEPLOYS OR MUTATES A RESOURCE. `stage-cert` reads AWS (the verifier's reads) and writes only the evidence
// directory. `stage-probe task-role` sends only the IAM probe's impossible-condition writes (nothing can be written), KMS
// Signs over disposable digests, and -- only with `--disposable-writes L6CERT#<run>` typed out -- writes and deletes the
// one disposable partition. `stage-probe edge` sends GETs and opens two sockets. There is no general --force.

import * as fs from "fs";
import * as path from "path";

import type { DeployDeps } from "../commands";
import { actionListOf, clientsFor, collectVerification, environmentOf, gameGenerationsOf, generationOf, loadAndMatch, need, parseFlags, UsageError, EXIT_FAILED, EXIT_NOT_EVALUATED, EXIT_OK } from "../commands";
import { EVIDENCE_FILES, expectedNames } from "../deployVerify";
import { RELAYER_ADDRESS } from "../relayerRotation";
import { certify, certificationText, clearCertification, idleBoundsOf, prerequisiteChecks, prerequisitePassed, prerequisiteRecord, SCENARIOS, writeCertification, type CertContext, type Scenario, type StagingGate } from "./certify";
import { DRILL_FILES } from "./drills";
import { requiredIdleMs, runEdgeProbe, SESSION_COOKIE_ENV, type EdgeTransport } from "./edgeProbe";
import { EXIT_NOT_YET, probeOverrides, recordFlipAlarms, stagePhase, windowOpen } from "./flipAlarmDrill";
import { precheckRestoreCase, recordRestoreAlarms, stageRestoreCase } from "./restoreAlarmDrill";
import { EXIT_NOT_YET as EXIT_RESTORE_NOT_YET, RESTORE_CASES, restoreProbeOverrides, type RestoreCase } from "./restoreAlarmProbe";
import { restoreFencingCommand } from "./restoreFencing";
import { MAINNET_CHAIN_IDS, type KmsClient } from "../../../escrow/juno/signer";
import type { JunoBackendConfig } from "../../../escrow/juno/junoConfig";
import { arr, disposablePartition, EVIDENCE, isoOf, obj, PROBE_FORMAT, readEvidence, recordFromLog, recordLines, runIdProblem, scrub, secretFindings, sha256Hex, stableStringify, writeRecord } from "./evidence";

export { recordFromLog, recordLines } from "./evidence";
import { newProbeNonce, runIamProbe } from "./iamProbe";
import { adoptionOf, buildCapabilities, readGenerationEvidence, readIdentityRecovery, readRestoreHeartbeats, type RecoveryReaders, type TaskHeartbeatReader } from "./recovery";
import { runKmsProbe } from "./kmsProbe";
import { decodeCapture } from "../migration/arm64LiveSmoke";
import { HOST_ROLE_FILES, HOST_ROLE_PROBES, HOST_ROLE_WRAPPER, hostRoleVerdictRecord, judgeHostRoleCapture, wrapperSha256, type HostRoleProbe } from "./hostRoleProbe";
import { HOST_EDGE_FILES, judgeSingleHostEdge, readHostEdgeEvidence, SINGLE_HOST_EDGE_VERDICT_FILE, singleHostEdgeVerdictRecord, singleHostRequiredIdleMs } from "./singleHostEdge";
import { runTransactionProbe } from "./transactionProbe";
import { collectRotationProof, ROTATION_PROOF_FILE, type RotationReaders } from "./rotationProof";

export interface StagingDeps {
  /** The process environment (the certifier task's BUILD_ID, its runtime document reference, the session cookie). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** A monotonic clock in ms (`performance.now`), for latencies. */
  readonly monotonic: () => number;
  readonly edge: EdgeTransport;
  /** The repository checkout (the committed Terraform lock files); `--repository` overrides it. */
  readonly repository: string;
  /** Extra gates (a later LIVE-6 branch's); none by default. */
  readonly extraGates?: readonly StagingGate[];
  /** Inside an ECS task: this task's ARN, from the task metadata endpoint (`ECS_CONTAINER_METADATA_URI_V4`/task); null
   *  elsewhere. The certification ties the record to the certifier task's own `describe-tasks` by it. */
  readonly taskArn?: () => Promise<string | null>;
  /** L6-4's strict readers (`recovery.ts`), bound by the integration that contains L6-4; absent here, so the recovery
   *  gates FAIL "not integrated". */
  readonly recovery?: RecoveryReaders;
  /** L6-5A's TASK# heartbeats (operator proof for a restore drill, never a lease): the reader of the PREVIOUS generation's
   *  table, bound by the integration (`aws/runtime/taskHeartbeats.ts` `oldGenerationHeartbeatsAfter`, in
   *  `tools/awsDeploy.ts`); absent: the restore-quiet gate says the stop is proven from ECS alone. */
  readonly heartbeats?: TaskHeartbeatReader;
  /** LIVE-6 relayer rotation: the deployment's own readers for the post-rotation proof (`rotationProof.ts`), bound by the
   *  integration in `tools/awsDeploy.ts`; absent: the proof gate FAILS "not integrated". The chain reader is DeployDeps'. */
  readonly rotation?: RotationReaders;
}

/** The KMS client for the configured keys' region (null configuration, no KMS region, or no binding: undefined -- the
 *  proof then FAILS "no KMS public-key reader"). Only `getPublicKey` is ever called through it by the proof. */
function relayerKmsOf(deps: DeployDeps, config: JunoBackendConfig | null): KmsClient | undefined {
  if (config === null || config.kmsRegion === null) return undefined;
  try {
    return deps.kms(config.kmsRegion).digest;
  } catch {
    return undefined;
  }
}

const runOf = (flags: Map<string, string>): string => {
  const run = need(flags, "--run-id");
  const problem = runIdProblem(run);
  if (problem !== null) throw new UsageError(problem);
  return run;
};

const poolsOf = (flags: Map<string, string>, primary: string): string[] => (flags.get("--pools") ?? primary).split(",").map((p) => p.trim()).filter((p) => p.length > 0);

const portOf = (flags: Map<string, string>): number => {
  const port = Number(flags.get("--port") ?? "8917");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new UsageError("--port must be a TCP port");
  return port;
};

/* LIVE-6 final convergence: the verifier's L6-5B flags too (`verify`'s own meaning): every managed generation's TTL, and the
   alarm classes' destinations (`none` = an empty list, valid in staging). */
const VERIFY_FLAGS = ["--runtime-parameter", "--environment", "--primary-pool", "--generation", "--pools", "--port", "--part", "--game-generations", "--page-actions", "--ticket-actions"];

async function prerequisiteFor(flags: Map<string, string>, dir: string, run: string, deps: DeployDeps, staging: StagingDeps) {
  const part = flags.get("--part") ?? "app";
  if (part !== "app" && part !== "all") throw new UsageError("--part is app or all (the ledger half: `verify --part ledger --record`)");
  const environment = environmentOf(need(flags, "--environment"));
  const generation = generationOf(need(flags, "--generation"));
  const primaryPool = need(flags, "--primary-pool");
  const pools = poolsOf(flags, primaryPool);
  /* LIVE-6 final convergence: a flip drill's L6-2 flip record lives in the evidence (`flip-record.json`); when present, the
     verifier judges the role changes and the suppressors against ITS window, exactly as `verify --flip-record`. */
  const flipRecord = path.join(dir, DRILL_FILES.flipRecord);
  const verification = await collectVerification(
    {
      part,
      runtimeParameterArn: need(flags, "--runtime-parameter"),
      environment,
      primaryPool,
      generation,
      pools,
      port: portOf(flags),
      evidenceDir: dir,
      flipRecordFile: fs.existsSync(flipRecord) ? flipRecord : null,
      gameGenerations: gameGenerationsOf(flags, generation),
      pageActions: actionListOf(flags, "--page-actions"),
      ticketActions: actionListOf(flags, "--ticket-actions"),
    },
    deps,
  );
  const expect = { run, environment, generation, primaryPool, pools, part } as const;
  /* L6-4: SYSTEM/GENERATION and APPGEN's binding, read live through L6-4's own readers (when bound). */
  const { clients, tables } = clientsFor(deps, verification.startup);
  const generationEvidence = await readGenerationEvidence(staging.recovery, clients, { game: tables.game, ledger: tables.ledger });
  return { expect, result: prerequisiteChecks(dir, verification, expect), generationEvidence, clients, tables, startup: verification.startup };
}

/* ------------------------------------------------------------------ */
/* stage-cert                                                           */
/* ------------------------------------------------------------------ */

export async function stageCertCommand(argv: readonly string[], deps: DeployDeps, staging: StagingDeps): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "prerequisite") {
    const flags = parseFlags(rest, ["--run-id", "--evidence", ...VERIFY_FLAGS], []);
    const run = runOf(flags);
    const dir = need(flags, "--evidence");
    /* An older PASS never survives a rerun that fails or is refused (the certifier-task script trusts this file). */
    fs.rmSync(path.join(dir, EVIDENCE.prerequisite), { force: true });
    const { expect, result } = await prerequisiteFor(flags, dir, run, deps, staging);
    const record = prerequisiteRecord(run, deps.now(), expect, result);
    writeRecord(dir, EVIDENCE.prerequisite, record);
    for (const c of result.checks) deps.out(`${c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "SKIP"}  ${c.name} -- ${c.detail}`);
    deps.out(`PREREQUISITE ${String(record.verdict)}: ${path.join(dir, EVIDENCE.prerequisite)}${record.verdict === "PASS" ? " (the probes may run for this run id)" : " (no probe may run: settle the deployment and capture again)"}`);
    return record.verdict === "PASS" ? EXIT_OK : EXIT_FAILED;
  }
  if (sub === "certify") {
    const flags = parseFlags(rest, ["--run-id", "--evidence", "--scenario", "--replaced-pools", "--commit", "--repository", "--from-relayer", "--to-relayer", ...VERIFY_FLAGS], []);
    const run = runOf(flags);
    const dir = need(flags, "--evidence");
    const scenario = need(flags, "--scenario");
    if (!(SCENARIOS as readonly string[]).includes(scenario)) throw new UsageError(`--scenario is ${SCENARIOS.join(", ")}`);
    const replacedPools = (flags.get("--replaced-pools") ?? "").split(",").map((p) => p.trim()).filter((p) => p.length > 0);
    if (scenario !== "replacement" && replacedPools.length > 0) throw new UsageError("--replaced-pools belongs to --scenario replacement");
    /* LIVE-6 final convergence: the relayer-address rotation this drill certifies (L6-2 / L6-7's gate). */
    const fromRelayer = flags.get("--from-relayer") ?? null;
    const toRelayer = flags.get("--to-relayer") ?? null;
    if ((fromRelayer !== null || toRelayer !== null) && scenario !== "relayer-rotation-drill") throw new UsageError("--from-relayer / --to-relayer belong to --scenario relayer-rotation-drill");
    if (scenario === "relayer-rotation-drill" && (fromRelayer === null || toRelayer === null || !RELAYER_ADDRESS.test(fromRelayer) || !RELAYER_ADDRESS.test(toRelayer) || fromRelayer === toRelayer)) throw new UsageError("--scenario relayer-rotation-drill needs --from-relayer <old> --to-relayer <new> (two different relayer addresses)");
    const commit = need(flags, "--commit");
    /* An older certification's PASS never survives a rerun that fails or is refused. */
    clearCertification(dir);
    const { expect, result, generationEvidence, clients, tables, startup } = await prerequisiteFor(flags, dir, run, deps, staging);
    if (replacedPools.some((p) => !expect.pools.includes(p))) throw new UsageError("--replaced-pools must be among --pools");
    const ctx: CertContext = {
      dir,
      run,
      scenario: scenario as Scenario,
      replacedPools,
      environment: expect.environment,
      generation: expect.generation,
      primaryPool: expect.primaryPool,
      pools: expect.pools,
      commit,
      repository: flags.get("--repository") ?? staging.repository,
      prerequisite: result,
      generationEvidence,
      /* L6-5A/L6-5B's TASK# evidence for L6-6R's restore quietness: the PREVIOUS generation's table, after the stop. */
      heartbeats:
        scenario === "restore-drill"
          ? await readRestoreHeartbeats(staging.heartbeats, clients.app, {
              dir,
              adoption: adoptionOf(generationEvidence),
              tableOf: (g) => {
                const name = expectedNames(expect.environment, g).gameTable;
                return deps.tables?.({ gameTable: name, identityTable: startup.config.identityTable, ledgerArn: startup.config.ledger.arn }).game ?? name;
              },
            })
          : null,
      alarmActions: { page: actionListOf(flags, "--page-actions"), ticket: actionListOf(flags, "--ticket-actions") },
      rotation: scenario === "relayer-rotation-drill" ? { from: fromRelayer, to: toRelayer } : null,
      /* LIVE-6 relayer rotation: the post-rotation proof, read LIVE now (read-only), kept in the package, judged in memory. */
      rotationProof:
        scenario === "relayer-rotation-drill" && fromRelayer !== null && toRelayer !== null
          ? await collectRotationProof({
              readers: staging.rotation,
              juno: deps.juno,
              /* v2 (LIVE-6 L6-12D): the configured relayer key's PUBLIC key, through the deployment's KMS binding (the
                 configuration's own KMS region; GetPublicKey only -- nothing is signed). */
              kms: relayerKmsOf(deps, startup.escrowConfig),
              clients,
              tables,
              config: startup.escrowConfig,
              run,
              environment: expect.environment,
              from: fromRelayer,
              to: toRelayer,
              now: deps.now,
            })
          : null,
    };
    if (ctx.rotationProof !== null && ctx.rotationProof !== undefined) writeRecord(dir, ROTATION_PROOF_FILE, ctx.rotationProof);
    const verdict = certify(ctx, staging.extraGates ?? []);
    writeCertification(ctx, verdict);
    for (const line of certificationText(ctx, verdict).trimEnd().split("\n")) deps.out(line);
    return verdict.passed ? EXIT_OK : EXIT_FAILED;
  }
  throw new UsageError("stage-cert prerequisite | certify");
}

/* ------------------------------------------------------------------ */
/* stage-probe                                                          */
/* ------------------------------------------------------------------ */

export async function stageProbeCommand(argv: readonly string[], deps: DeployDeps, staging: StagingDeps): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "task-role") return taskRoleProbe(rest, deps, staging);
  if (sub === "edge") return edgeProbe(rest, deps, staging);
  if (sub === "host-role") return hostRoleProbeCommand(rest, deps, staging);
  if (sub === "collect") {
    const flags = parseFlags(rest, ["--run-id", "--evidence"], []);
    const run = runOf(flags);
    const dir = need(flags, "--evidence");
    const log = readEvidence(dir, EVIDENCE.taskRoleLog);
    if (!log.ok) throw new UsageError(log.problem);
    const messages = arr(obj(log.value).events).map((e) => String(obj(e).message ?? ""));
    const got = recordFromLog(messages);
    if (!got.ok) {
      deps.out(`NOT COLLECTED: ${got.problem}`);
      return EXIT_FAILED;
    }
    if (obj(got.record).run_id !== run || obj(got.record).format !== PROBE_FORMAT) {
      deps.out(`NOT COLLECTED: the log's record is run ${String(obj(got.record).run_id)} (${String(obj(got.record).format)}), not ${run}`);
      return EXIT_FAILED;
    }
    writeRecord(dir, EVIDENCE.taskRole, got.record);
    deps.out(`COLLECTED: ${path.join(dir, EVIDENCE.taskRole)}`);
    return EXIT_OK;
  }
  if (sub === "flip-alarms") return flipAlarmsCommand(rest, deps);
  if (sub === "restore-alarms") return restoreAlarmsCommand(rest, deps);
  if (sub === "restore-fencing") return restoreFencingCommand(rest, deps, (clients, tables) => readGenerationEvidence(staging.recovery, clients, tables));
  throw new UsageError("stage-probe task-role | edge | host-role | collect | flip-alarms | restore-alarms | restore-fencing");
}

/**
 * The flip drill's alarm observations (`flipAlarmDrill.ts`; run by infra/aws/scripts/run-flip-alarm-probe.{ps1,sh}):
 *   overrides --mode inject|hold --environment <env> --pool <pool> --run-id R [--hold-seconds N]   the probe task's overrides (JSON)
 *   window    --run-id R --evidence <dir>                     exit 0 only while the flip record's window is open
 *   observe   --run-id R --evidence <dir> --environment <env> --pools p1,p2 --phase a1|during|after
 *             0 observed and staged; 10 not yet (poll); 1 refused
 *   record    --run-id R --evidence <dir> --environment <env> --pools p1,p2     writes probe-flip-alarms.json, judged first
 * Reads only the evidence directory (the scripts capture AWS); writes only the evidence directory.
 */
function flipAlarmsCommand(argv: readonly string[], deps: DeployDeps): number {
  const [sub, ...rest] = argv;
  if (sub === "overrides") {
    const flags = parseFlags(rest, ["--mode", "--environment", "--pool", "--run-id", "--hold-seconds"], []);
    const mode = need(flags, "--mode");
    if (mode !== "inject" && mode !== "hold") throw new UsageError("--mode is inject or hold");
    const holdText = flags.get("--hold-seconds");
    if (holdText !== undefined && mode !== "hold") throw new UsageError("--hold-seconds is for --mode hold");
    try {
      deps.out(JSON.stringify(probeOverrides({ mode, environment: environmentOf(need(flags, "--environment")), pool: need(flags, "--pool"), run: runOf(flags), ...(holdText === undefined ? {} : { holdSeconds: Number(holdText) }) })));
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
    return EXIT_OK;
  }
  if (sub === "window") {
    const flags = parseFlags(rest, ["--run-id", "--evidence"], []);
    runOf(flags);
    const answer = windowOpen(need(flags, "--evidence"), deps.now());
    deps.out(`${answer.open ? "WINDOW OPEN" : "WINDOW NOT OPEN"}: ${answer.detail}`);
    return answer.open ? EXIT_OK : EXIT_FAILED;
  }
  if (sub === "observe" || sub === "record") {
    const flags = parseFlags(rest, ["--run-id", "--evidence", "--environment", "--pools", "--phase"], []);
    const ctx = { dir: need(flags, "--evidence"), run: runOf(flags), environment: environmentOf(need(flags, "--environment")), pools: need(flags, "--pools").split(",").map((p) => p.trim()).filter((p) => p.length > 0) };
    if (ctx.pools.length < 2) throw new UsageError("--pools names the deployment's pools (a flip has at least two)");
    let verdict;
    if (sub === "observe") {
      const phase = need(flags, "--phase");
      if (phase !== "a1" && phase !== "during" && phase !== "after") throw new UsageError("--phase is a1, during or after");
      verdict = stagePhase(ctx, phase);
    } else {
      if (flags.has("--phase")) throw new UsageError("record takes no --phase");
      verdict = recordFlipAlarms(ctx);
    }
    if (verdict.kind === "observed") {
      deps.out(`${sub === "record" ? "RECORDED" : "OBSERVED"}: ${verdict.value}`);
      return EXIT_OK;
    }
    deps.out(`${verdict.kind === "not-yet" ? "NOT YET" : "REFUSED"}: ${verdict.reasons.join("; ")}`);
    return verdict.kind === "not-yet" ? EXIT_NOT_YET : EXIT_FAILED;
  }
  throw new UsageError("stage-probe flip-alarms overrides | window | observe | record");
}

const poolsFlag = (flags: Map<string, string>): string[] => need(flags, "--pools").split(",").map((p) => p.trim()).filter((p) => p.length > 0);
const caseOf = (flags: Map<string, string>): RestoreCase => {
  const c = need(flags, "--case");
  if (!(RESTORE_CASES as readonly string[]).includes(c)) throw new UsageError(`--case is ${RESTORE_CASES.join(", ")}`);
  return c as RestoreCase;
};

/**
 * The restore drill's alarm observations (`restoreAlarmDrill.ts`; run by infra/aws/scripts/run-restore-alarm-probe.{ps1,sh}):
 *   overrides --case r1|a4g|a4i|r2|r3 --environment <env> --pool <pool> --run-id R [--hold-seconds N]   the probe task's overrides
 *   precheck  --run-id R --evidence <dir> --environment <env> --pools p1,p2 --case C --pool P [--overlap]
 *             0 the launch record written (start the task); 10 not yet (recapture, poll); 1 refused (start nothing)
 *   observe   --run-id R --evidence <dir> --environment <env> --case C        0 observed and staged; 10 not yet; 1 refused
 *   record    --run-id R --evidence <dir> --environment <env> --pools p1,p2   writes probe-restore-alarms.json, judged first
 * Reads only the evidence directory (the scripts capture AWS); writes only the evidence directory.
 */
function restoreAlarmsCommand(argv: readonly string[], deps: DeployDeps): number {
  const [sub, ...rest] = argv;
  if (sub === "overrides") {
    const flags = parseFlags(rest, ["--case", "--environment", "--pool", "--run-id", "--hold-seconds"], []);
    const holdText = flags.get("--hold-seconds");
    if (holdText !== undefined && !/^[0-9]{1,6}$/.test(holdText)) throw new UsageError("--hold-seconds is a whole number of seconds");
    try {
      deps.out(JSON.stringify(restoreProbeOverrides({ case: caseOf(flags), environment: environmentOf(need(flags, "--environment")), pool: need(flags, "--pool"), run: runOf(flags), ...(holdText === undefined ? {} : { holdSeconds: Number(holdText) }) })));
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError((error as Error).message);
    }
    return EXIT_OK;
  }
  let verdict;
  if (sub === "precheck") {
    const flags = parseFlags(rest, ["--run-id", "--evidence", "--environment", "--pools", "--case", "--pool"], ["--overlap"]);
    const ctx = { dir: need(flags, "--evidence"), run: runOf(flags), environment: environmentOf(need(flags, "--environment")), pools: poolsFlag(flags) };
    verdict = precheckRestoreCase(ctx, { case: caseOf(flags), pool: need(flags, "--pool"), overlap: flags.has("--overlap"), now: deps.now() });
  } else if (sub === "observe") {
    const flags = parseFlags(rest, ["--run-id", "--evidence", "--environment", "--case"], []);
    verdict = stageRestoreCase({ dir: need(flags, "--evidence"), run: runOf(flags), environment: environmentOf(need(flags, "--environment")) }, caseOf(flags));
  } else if (sub === "record") {
    const flags = parseFlags(rest, ["--run-id", "--evidence", "--environment", "--pools"], []);
    verdict = recordRestoreAlarms({ dir: need(flags, "--evidence"), run: runOf(flags), environment: environmentOf(need(flags, "--environment")), pools: poolsFlag(flags) });
  } else throw new UsageError("stage-probe restore-alarms overrides | precheck | observe | record");
  if (verdict.kind === "observed") {
    deps.out(`${sub === "record" ? "RECORDED" : sub === "precheck" ? "CLEARED" : "OBSERVED"}: ${verdict.value}`);
    return EXIT_OK;
  }
  deps.out(`${verdict.kind === "not-yet" ? "NOT YET" : "REFUSED"}: ${verdict.reasons.join("; ")}`);
  return verdict.kind === "not-yet" ? EXIT_RESTORE_NOT_YET : EXIT_FAILED;
}

/** Runs INSIDE the certifier task (the task role, the task's network, the task's own runtime document). */
async function taskRoleProbe(argv: readonly string[], deps: DeployDeps, staging: StagingDeps): Promise<number> {
  const flags = parseFlags(argv, ["--run-id", "--runtime-parameter", "--environment", "--generation", "--pool", "--kms-samples", "--disposable-writes", "--conflict-rounds", "--conflict-writers"], []);
  const run = runOf(flags);
  const environment = environmentOf(need(flags, "--environment"));
  const generation = generationOf(need(flags, "--generation"));
  const pool = need(flags, "--pool");
  const arn = need(flags, "--runtime-parameter");
  const samples = Number(flags.get("--kms-samples") ?? "5");
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 50) throw new UsageError("--kms-samples is 1..50");
  const rounds = Number(flags.get("--conflict-rounds") ?? "20");
  const writers = Number(flags.get("--conflict-writers") ?? "6");
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 200 || !Number.isSafeInteger(writers) || writers < 2 || writers > 16) throw new UsageError("--conflict-rounds is 1..200, --conflict-writers 2..16");
  const disposable = flags.get("--disposable-writes");
  if (disposable !== undefined && disposable !== disposablePartition(run)) throw new UsageError(`--disposable-writes must be exactly ${disposablePartition(run)} (the only partition it may write)`);
  if (disposable !== undefined && /^prod/.test(environment)) throw new UsageError("the transaction probe never writes in a prod* environment");

  const startedAt = isoOf(deps.now());
  const startup = await loadAndMatch(deps, arn, { environment, pool, generation });
  const { config } = startup;
  /* The staging certification's probe never runs beside a MAINNET escrow configuration (its keys would sign, its tables
     would take disposable writes): whatever the environment is called. */
  if (startup.escrowConfig !== null && (startup.escrowConfig.networkClass === "mainnet" || MAINNET_CHAIN_IDS.includes(startup.escrowConfig.chainId))) {
    throw new UsageError(`the runtime document ${arn} names a mainnet escrow configuration: the staging probe refuses to run there`);
  }
  const game = deps.dynamo(config.region);
  const ledger = config.ledger.region === config.region ? game : deps.dynamo(config.ledger.region);
  const tables = deps.tables?.({ gameTable: config.gameTable, identityTable: config.identityTable, ledgerArn: config.ledger.arn }) ?? { game: config.gameTable, identity: config.identityTable, ledger: config.ledger.arn };
  const sections: Record<string, unknown> = {};

  deps.out(`stage-probe task-role ${run}: ${environment} g${generation} pool ${pool}; runtime document v${startup.configVersion}`);
  const nonce = newProbeNonce();
  try {
    sections.iam = { status: "ran", ...(await runIamProbe({ game, ledger }, { run, gameTable: tables.game, ledgerTable: tables.ledger, nonce })) };
  } catch (error) {
    sections.iam = { status: "not-run", reason: `the probe failed to run: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` };
  }
  deps.out(`  iam: ${String(obj(sections.iam).status)}`);

  const escrow = startup.escrowConfig;
  if (escrow === null || escrow.kmsRegion === null) sections.kms = { status: "not-run", reason: "escrow is null (no KMS keys)" };
  else {
    try {
      sections.kms = { status: "ran", results: await runKmsProbe(escrow, { kms: deps.kms(escrow.kmsRegion).digest, clock: staging.monotonic }, { run, samples }) };
    } catch (error) {
      sections.kms = { status: "not-run", reason: `the probe failed to run: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` };
    }
  }
  deps.out(`  kms: ${String(obj(sections.kms).status)}`);

  if (disposable === undefined) sections.transactions = { status: "not-run", reason: `--disposable-writes ${disposablePartition(run)} was not given` };
  else {
    try {
      sections.transactions = { status: "ran", partition: disposable, results: await runTransactionProbe(game, { run, gameTable: tables.game, conflictRounds: rounds, conflictWriters: writers }) };
    } catch (error) {
      sections.transactions = { status: "not-run", reason: `the probe failed to run: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}` };
    }
  }
  deps.out(`  transactions: ${String(obj(sections.transactions).status)}`);

  /* L6-4: the identity table's restore state, TABLE#identity and REVIEW# (read-only, through L6-4's readers when bound). */
  sections.identity_state = await readIdentityRecovery(staging.recovery, game, tables.identity);
  deps.out(`  identity_state: ${String(obj(sections.identity_state).status)}`);

  const envArn = staging.env.GS_AWS_CONFIG_PARAMETER;
  const record = {
    format: PROBE_FORMAT,
    probe: "task-role",
    run_id: run,
    environment,
    generation,
    pool,
    started_at: startedAt,
    finished_at: isoOf(deps.now()),
    runner: {
      ecs_task: typeof staging.env.ECS_CONTAINER_METADATA_URI_V4 === "string" && staging.env.ECS_CONTAINER_METADATA_URI_V4.length > 0,
      task_arn: staging.taskArn === undefined ? null : await staging.taskArn().catch(() => null),
      build_id: staging.env.BUILD_ID ?? null,
      /* Which L6-4 modules this image carries: the rollback gate's evidence from the image itself. */
      build_capabilities: buildCapabilities(),
      runtime_parameter_matches_env: envArn === undefined ? null : envArn === arn,
    },
    runtime_document_version: startup.configVersion,
    sections,
  };
  /* Refused, not printed, if anything in it looks secret: the log (CloudWatch) is evidence too. */
  const findings = secretFindings(stableStringify(record), { ownRecord: true });
  if (findings.length > 0) {
    deps.out(`NOT RECORDED: the record would carry ${findings.join(", ")}; nothing was printed (the certification fails without it)`);
    return EXIT_FAILED;
  }
  for (const line of recordLines(record)) deps.out(line);
  return EXIT_OK;
}

/** Runs on the operator's machine, against the distribution's public name. `--topology ecs` (the default) is L6-6's
 *  probe, unchanged: it stands on `stage-cert prerequisite` and the ALB's idle timeout and is judged by `stage-cert
 *  certify`. `--topology single-host` (PHASE 1 REMAINDER, step 16) stands on the single host's step-15b evidence instead
 *  (`singleHostEdge.ts`) and judges its own record. Neither path's evidence can stand in for the other's. */
async function edgeProbe(argv: readonly string[], deps: DeployDeps, staging: StagingDeps): Promise<number> {
  const flags = parseFlags(argv, ["--run-id", "--evidence", "--base-url", "--origin", "--environment", "--generation", "--pool", "--expected-client-ip", "--hold-seconds", ...EDGE_TOPOLOGY_FLAGS], []);
  const topology = flags.get("--topology") ?? "ecs";
  if (topology !== "ecs" && topology !== "single-host") throw new UsageError("--topology is ecs (the default: the ALB path) or single-host (CloudFront -> Caddy on the host)");
  if (topology === "ecs") {
    const hostFlags = EDGE_TOPOLOGY_FLAGS.filter((f) => f !== "--topology" && flags.has(f));
    if (hostFlags.length > 0) throw new UsageError(`${hostFlags.join(", ")}: the single host's evidence belongs to --topology single-host (the ECS path stands on stage-cert prerequisite and the ALB's idle timeout)`);
  }
  const run = runOf(flags);
  const dir = need(flags, "--evidence");
  const environment = environmentOf(need(flags, "--environment"));
  const generation = generationOf(need(flags, "--generation"));
  const pool = need(flags, "--pool");
  const base = new URL(need(flags, "--base-url"));
  if (base.protocol !== "https:" || base.pathname !== "/" || base.search !== "" || base.username !== "" || base.password !== "") throw new UsageError("--base-url is https://<the distribution's name or alias> with no path, query or credentials");
  const origin = need(flags, "--origin");
  if (!/^https:\/\/[^/]+$/.test(origin)) throw new UsageError("--origin is an https origin (one of GS_ALLOWED_ORIGINS)");
  if (topology === "single-host") return singleHostEdgeProbe(flags, { run, dir, environment, generation, pool, base, origin }, deps, staging);
  if (!prerequisitePassed(dir, run)) throw new UsageError(`${EVIDENCE.prerequisite} in ${dir} is not PASS for ${run}: run \`stage-cert prerequisite\` first (no probe runs against an unsettled deployment)`);
  const bounds = idleBoundsOf(dir);
  if (bounds.albIdleSeconds === null || bounds.originReadTimeoutSeconds === null) throw new UsageError(`the evidence has no ALB idle timeout or CloudFront origin read timeout (${EVIDENCE_FILES.loadBalancerAttributes}, ${EVIDENCE_FILES.distributionConfig})`);
  const required = requiredIdleMs(bounds.albIdleSeconds, bounds.originReadTimeoutSeconds);
  const hold = flags.has("--hold-seconds") ? Number(flags.get("--hold-seconds")) * 1000 : required + 10_000;
  if (!Number.isSafeInteger(hold) || hold < required) throw new UsageError(`--hold-seconds must be at least ${Math.ceil(required / 1000)} (the path's longest idle bound plus two server ping periods)`);
  const cookie = staging.env[SESSION_COOKIE_ENV];
  const startedAt = isoOf(deps.now());
  deps.out(`stage-probe edge ${run}: ${base.host}; the idle socket is held ${Math.round(hold / 1000)} s (required ${Math.round(required / 1000)} s)`);
  const sections = await runEdgeProbe(staging.edge, {
    run,
    baseUrl: base.origin,
    origin,
    sessionCookie: cookie === undefined || cookie === "" ? null : cookie,
    expectedClientIp: flags.get("--expected-client-ip") ?? null,
    albIdleSeconds: bounds.albIdleSeconds,
    originReadTimeoutSeconds: bounds.originReadTimeoutSeconds,
    holdMs: hold,
  });
  const record = { format: PROBE_FORMAT, probe: "edge", run_id: run, environment, generation, pool, started_at: startedAt, finished_at: isoOf(deps.now()), sections };
  const where = writeRecord(dir, EVIDENCE.edge, JSON.parse(scrub(JSON.stringify(record), cookie === undefined ? [] : [cookie])) as unknown);
  deps.out(`RECORDED: ${where} (judged by stage-cert certify)`);
  return EXIT_OK;
}

/** `stage-probe edge --topology single-host`'s own flags (refused on the ECS path). */
const EDGE_TOPOLOGY_FLAGS = ["--topology", "--host-evidence", "--instance-id", "--origin-hostname"];

const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;
const DNS_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** PHASE 1 REMAINDER (step 16): the edge probe on the single host's path, judged here (`stage-cert certify` is the ECS
 *  path's). Exit 0 only on PASS; nothing is probed unless the host evidence PASSES first. */
async function singleHostEdgeProbe(
  flags: Map<string, string>,
  p: { readonly run: string; readonly dir: string; readonly environment: string; readonly generation: number; readonly pool: string; readonly base: URL; readonly origin: string },
  deps: DeployDeps,
  staging: StagingDeps,
): Promise<number> {
  const hostDir = need(flags, "--host-evidence");
  const instanceId = need(flags, "--instance-id");
  if (!INSTANCE_ID.test(instanceId)) throw new UsageError("--instance-id is the single host's i-... id");
  const originHostname = need(flags, "--origin-hostname").toLowerCase();
  if (!DNS_NAME.test(originHostname)) throw new UsageError("--origin-hostname is the host's origin DNS name (stacks/single-host origin_hostname)");
  if (path.resolve(hostDir) === path.resolve(p.dir)) throw new UsageError("--host-evidence is step 15b's capture directory; --evidence is this probe's own (they are not the same directory)");
  /* An older verdict never survives a rerun that fails or is refused. */
  fs.rmSync(path.join(p.dir, SINGLE_HOST_EDGE_VERDICT_FILE), { force: true });
  const expectHost = { environment: p.environment, generation: p.generation, instanceId, originHostname, baseHost: p.base.host, now: deps.now() };
  const evidence = readHostEdgeEvidence(hostDir, expectHost);
  if (!evidence.ok || evidence.bounds === null || evidence.binding === null) {
    for (const c of evidence.checks) if (c.status !== "pass") deps.out(`FAIL  ${c.name} -- ${c.detail}`);
    throw new UsageError(`the single host's edge evidence in ${hostDir} is not PASS (above): no probe runs against an unverified path (run step 15b again: capture-host-evidence, host-snapshot, verify --topology coexist ... --record ${HOST_EDGE_FILES.verify} --report <dir>)`);
  }
  const required = singleHostRequiredIdleMs(evidence.bounds.originReadTimeoutSeconds);
  const hold = flags.has("--hold-seconds") ? Number(flags.get("--hold-seconds")) * 1000 : required + 10_000;
  if (!Number.isSafeInteger(hold) || hold < required) throw new UsageError(`--hold-seconds must be at least ${Math.ceil(required / 1000)} (the path's longest idle bound plus two server ping periods)`);
  const cookie = staging.env[SESSION_COOKIE_ENV];
  const startedAt = isoOf(deps.now());
  deps.out(`stage-probe edge --topology single-host ${p.run}: ${p.base.host} -> CloudFront -> ${originHostname} (${instanceId}); the idle socket is held ${Math.round(hold / 1000)} s (required ${Math.round(required / 1000)} s: CloudFront ${evidence.bounds.originReadTimeoutSeconds} s, Caddy ${evidence.bounds.proxyIdleSeconds} s)`);
  const sections = await runEdgeProbe(staging.edge, {
    run: p.run,
    baseUrl: p.base.origin,
    origin: p.origin,
    sessionCookie: cookie === undefined || cookie === "" ? null : cookie,
    expectedClientIp: flags.get("--expected-client-ip") ?? null,
    albIdleSeconds: evidence.bounds.proxyIdleSeconds,
    originReadTimeoutSeconds: evidence.bounds.originReadTimeoutSeconds,
    holdMs: hold,
    proxy: { name: "caddy", idleSeconds: evidence.bounds.proxyIdleSeconds },
  });
  const record = {
    format: PROBE_FORMAT,
    probe: "edge",
    topology: "single-host",
    run_id: p.run,
    environment: p.environment,
    generation: p.generation,
    pool: p.pool,
    started_at: startedAt,
    finished_at: isoOf(deps.now()),
    host: { instance_id: instanceId, origin_hostname: originHostname, evidence: evidence.binding },
    sections,
  };
  const where = writeRecord(p.dir, EVIDENCE.edge, JSON.parse(scrub(JSON.stringify(record), cookie === undefined ? [] : [cookie])) as unknown);
  deps.out(`RECORDED: ${where}`);
  /* Judged from the saved bytes against the host evidence as it is NOW (re-read): what was written is what is judged. */
  const saved = readEvidence(p.dir, EVIDENCE.edge, { ownRecord: true });
  const expectRun = { run: p.run, environment: p.environment, generation: p.generation, pool: p.pool, instanceId, originHostname };
  const now = readHostEdgeEvidence(hostDir, { ...expectHost, now: deps.now() });
  const verdict = saved.ok ? judgeSingleHostEdge(saved.value, now, expectRun) : { passed: false, checks: [{ name: "single-host edge probe: the saved record", status: "fail" as const, detail: saved.problem }], measurements: {} };
  const written = writeRecord(p.dir, SINGLE_HOST_EDGE_VERDICT_FILE, singleHostEdgeVerdictRecord(expectRun, verdict, deps.now()));
  for (const c of verdict.checks) deps.out(`${c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : c.status === "skipped" ? "SKIP" : "NOT EVALUATED"}  ${c.name} -- ${c.detail}`);
  deps.out(`SINGLE-HOST EDGE PROBE: ${verdict.passed ? "PASS" : "FAIL"} -- ${written}`);
  return verdict.passed ? EXIT_OK : EXIT_FAILED;
}

/**
 * PHASE 1 REMAINDER (F5 / F6): `stage-probe host-role --probe kms|transactions --run-id R --evidence <dir> --capture <file>
 * --environment <env> --generation <N> --pool <pool> --instance-id <i-...> --digest sha256:<hex> --build <id>` -- OFFLINE: judges the output saved from `gs-host role-probe` (hostRoleProbe.ts) and writes
 * the probe's record and the verdict into the evidence directory. Exit 0 PASS, 1 FAIL, 3 NOT EVALUATED. Create-once: a
 * verdict for this probe and run is never overwritten (a retry is a new run id, written beside it). The wrapper it compares
 * against is THIS build's checkout's (no override).
 */
function hostRoleProbeCommand(argv: readonly string[], deps: DeployDeps, staging: StagingDeps): number {
  const flags = parseFlags(argv, ["--probe", "--run-id", "--evidence", "--capture", "--environment", "--generation", "--pool", "--instance-id", "--digest", "--build"], []);
  const probe = need(flags, "--probe");
  if (!(HOST_ROLE_PROBES as readonly string[]).includes(probe)) throw new UsageError("--probe is kms (F5) or transactions (F6)");
  const run = runOf(flags);
  const dir = need(flags, "--evidence");
  const environment = environmentOf(need(flags, "--environment"));
  const generation = generationOf(need(flags, "--generation"));
  const pool = need(flags, "--pool");
  if (!/^[a-z][a-z0-9-]{0,15}$/.test(pool)) throw new UsageError("--pool must match ^[a-z][a-z0-9-]{0,15}$");
  const instanceId = need(flags, "--instance-id");
  if (!INSTANCE_ID.test(instanceId)) throw new UsageError("--instance-id is the single host's i-... id");
  const digest = need(flags, "--digest");
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new UsageError("--digest is the SERVING release's sha256:<64 hex>");
  const build = need(flags, "--build");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(build)) throw new UsageError("--build is the serving release's build id");
  const kind = probe as HostRoleProbe;
  const verdictFile = HOST_ROLE_FILES.verdict(kind, run);
  if (fs.existsSync(path.join(dir, verdictFile))) throw new UsageError(`${verdictFile} already exists in ${dir}: a verdict is never overwritten (run the probe again under a NEW run id)`);
  let raw: Buffer;
  try {
    raw = fs.readFileSync(need(flags, "--capture"));
  } catch {
    throw new UsageError("--capture is the file the gs-host role-probe output was saved to (Tee-Object / tee)");
  }
  let wrapper: string | null = null;
  try {
    wrapper = wrapperSha256(fs.readFileSync(path.join(staging.repository, HOST_ROLE_WRAPPER), "utf8"));
  } catch {
    wrapper = null;
  }
  const expect = { probe: kind, run, environment, generation, pool, instanceId, digest, build, wrapperSha256: wrapper };
  const judged = judgeHostRoleCapture(decodeCapture(raw), expect);
  let checks = judged.checks;
  let verdict = judged.verdict;
  if (judged.record !== null) {
    try {
      deps.out(`RECORDED: ${writeRecord(dir, HOST_ROLE_FILES.record(kind, run), judged.record)}`);
    } catch (error) {
      checks = [...checks, { name: "the probe's record is written", status: "fail", detail: (error as Error).message }];
      verdict = "FAIL";
    }
  }
  const written = writeRecord(dir, verdictFile, hostRoleVerdictRecord(expect, { ...judged, checks, verdict }, { at: deps.now(), captureSha256: sha256Hex(raw) }));
  for (const c of checks) deps.out(`${c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : c.status === "skipped" ? "SKIP" : "NOT EVALUATED"}  ${c.name} -- ${c.detail}`);
  deps.out(`HOST-ROLE PROBE ${kind === "kms" ? "F5 KMS" : "F6 DYNAMODB"}: ${verdict} -- ${written}`);
  return verdict === "PASS" ? EXIT_OK : verdict === "FAIL" ? EXIT_FAILED : EXIT_NOT_EVALUATED;
}
